// Copyright (c) 2019 chzesa
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

class WeTabCacheEvent {
	constructor() {
		this.listeners = [];
	}

	addListener(listener) {
		this.listeners.push(listener);
	}

	removeListener(listener) {
		for (let i = this.listeners.length - 1; i > -1; i--)
			if (this.listeners[i] == listener) this.listeners.splice(i, 1);
	}

	hasListener(listener) {
		let result = false;
		this.listeners.forEach(l => { if (l == listener) result = true; });
		return result;
	}

	async __notify(...params) {
		let cloned = this.listeners.slice(0);
		for (let i in cloned) {
			try {
				await cloned[i](...params);
			} catch(e) {
				console.log(e);
			}
		}
	}
}

function newCache(config = {}) {
	config.listeners = config.listeners === undefined ? {} : config.listeners;

	const self = {};
	const windows = {};
	const tabs = {};
	const activeTab = {};
	const tabValues = {};

	self.onActivated = new WeTabCacheEvent();
	self.onAttached = new WeTabCacheEvent();
	self.onCreated = new WeTabCacheEvent();
	self.onMoved = new WeTabCacheEvent();
	self.onRemoved = new WeTabCacheEvent();
	self.onUpdated = new WeTabCacheEvent();

	if (config.listeners.onActivated != undefined)
		self.onActivated.addListener(config.listeners.onActivated);
	if (config.listeners.onAttached != undefined)
		self.onAttached.addListener(config.listeners.onAttached);
	if (config.listeners.onCreated != undefined)
		self.onCreated.addListener(config.listeners.onCreated);
	if (config.listeners.onMoved != undefined)
		self.onMoved.addListener(config.listeners.onMoved);
	if (config.listeners.onRemoved != undefined)
		self.onRemoved.addListener(config.listeners.onRemoved);
	if (config.listeners.onUpdated != undefined)
		self.onUpdated.addListener(config.listeners.onUpdated);

	const tabValueKeys = config.tabValueKeys || [];
	let queue;
	let initialized = false;
	let logging = config.logging || 0
	let restoringClosedTabs = false;
	let pendingRestoreEvents = []
	let now = 0;

	if (config.auto === true) {
		queue = newSyncQueue({
			enabled: false
		});
	} else {
		queue = config.queue;
	}
	
	self.debug = function () {
		return {windows, tabs, activeTab, tabValues, queue};
	}

	function correctIndexing(windowId, from = 0, to = null) {
		let array = windows[windowId];
		if (array.length == 0) {
			delete activeTab[windowId];
			delete windows[windowId];
			return;
		}

		to = to == null ? array.length : Math.min(to, array.length);

		for (let i = from; i < to; i++) {
			array[i].index = i;
		}
	}

	function swapTabObject(oldTab, tab) {
		tabs[tab.id] = tab;
		let windowId = tab.windowId;

		if (oldTab.windowId == windowId) {
			if (oldTab.index != tab.index) {
				windows[windowId].splice(oldTab.index, 1);
				windows[windowId].splice(tab.index, 0, tab);
				correctIndexing(windowId
					, Math.min(oldTab.index, tab.index)
					, Math.max(oldTab.index, tab.index) + 1);
			}
			else {
				windows[windowId][tab.index] = tab;
			}
		}
		else {
			windows[oldTab.windowId].splice(oldTab.index, 1);
			correctIndexing(oldTab.windowId, oldTab.index);

			windows[windowId].splice(tab.index, 0, tab);
			correctIndexing(windowId, tab.index);
		}

		return tab;
	}

	function deleteTab(tabId) {
		let tab = tabs[tabId];
		if (tab == null) return;

		let windowId = tab.windowId;
		let index = tab.index;

		windows[windowId].splice(index, 1);
		delete tabs[tabId];
		delete tabValues[tabId];

		correctIndexing(windowId, index);
	}

	function getWindow(windowId) {
		if (windows[windowId] == null) {
			windows[windowId] = [];
		}

		return windows[windowId];
	}

	self.setValue = function (tabId, key, value) {
		let values = tabValues[tabId];
		if (values != null && values[key] != value) {
			values[key] = value;
			browser.sessions.setTabValue(tabId, key, value);
		}
	}

	self.getValue = function (tabId, key) {
		let values = tabValues[tabId];
		if (values != null) {
			return values[key];
		}

		return undefined;
	}

	self.removeValue = function(tabId, key) {
		let values = tabValues[tabId];
		if (values != null) {
			delete values[key];
		}

		browser.sessions.removeTabValue(tabId, key);
	}

	async function initializeTabValues(tabId) {
		if (tabValueKeys.length == 0) return;
		let promises = [];

		tabValueKeys.forEach(function (k) {
			promises.push(browser.sessions.getTabValue(tabId, k));
		});

		try {
			await Promise.all(promises);
		} catch(e) {
			console.log(e);
			return false;
		}

		let values = tabValues[tabId];

		for (let i = 0; i < tabValueKeys.length; i++) {
			let k = tabValueKeys[i];
			// if values[k] = promises[i] were done here, values[k] would
			// hold the promise if the value of the promise was undefined
			await promises[i].then(function (v) {
				if (v !== undefined) {
					values[k] = v;
				}
			});
		}

		return true;
	}

	processRestoredtabs = async function() {
		if (!restoringClosedTabs) {
			return;
		}

		if (logging > 0) console.log('[Q] Creating restored tabs')

		restoringClosedTabs = false;

		pendingRestoreEvents.sort((a, b) => a.tab.index - b.tab.index)

		for (let i in pendingRestoreEvents) {
			data = pendingRestoreEvents[i];
			await self.cacheOnCreated(data.tab, data.promises, true);
		}

		pendingRestoreEvents = []
	}

	self.cacheOnActivated = async function (info) {
		let tabId = info.tabId;
		let tab = tabs[tabId];
		if (logging > 1) console.log('[Q] onActivated', info, tab)
		await processRestoredtabs();
		if (tab == null) return;
		let windowId = tab.windowId;
		let oldTab = tabs[activeTab[windowId]];
		if (oldTab != null) {
			oldTab.active = false;
		}

		activeTab[windowId] = tabId;
		tab.active = true;

		await self.onActivated.__notify(tab, info);
	}

	self.cacheOnAttached = async function (tabId, info) {
		let tab = tabs[tabId];
		if (logging > 0) console.log('[Q] onAttached', tabId, info, tab)
		await processRestoredtabs();
		if (tab == null) return;

		let windowId = info.newWindowId;
		let index = info.newPosition;
		let oldWindowId = tab.windowId;
		let oldIndex = tab.index;
		let oldWindow = getWindow(oldWindowId);
		oldWindow.splice(oldIndex, 1);

		correctIndexing(oldWindowId, oldIndex);

		let newWindow = getWindow(windowId);
		newWindow.splice(index, 0, tab);
		correctIndexing(windowId, index);

		tab.windowId = windowId;

		info.oldWindowId = oldWindowId;
		info.oldPosition = oldIndex;

		// Resubmit stored values as they're apparently
		// lost when tab is moved between windows
		let values = tabValues[tab.id];
		for (let k in values) {
			browser.sessions.setTabValue(tabId, k, values[k]);
		}

		await self.onAttached.__notify(tab, info);
	}

	isTabRestored = async function(tab, promises) {
		if (tab.lastAccessed !== undefined & tab.lastAccessed < now) {
			return true;
		}

		let values = null;

		try {
			values = await promises;
		} catch (e)  {
			return false;
		}

		for (let i in values) {
			try {
				if (await values[i] !== undefined) {
					return true;
				}
			} catch(e) {
				return false;
			}
		}

		return false;
	}

	self.cacheOnCreated = async function (tab, promises, delayed = false) {
		if (logging > 0) console.log('[Q] onCreated', tab)
		if (!restoringClosedTabs & !delayed & await isTabRestored(tab, promises)) {
			if (logging > 0) console.log('[Q] Detected tab restore')
			restoringClosedTabs = true;
		}

		if (restoringClosedTabs) {
			if (logging > 0) console.log('[Q] Delaying tab creation')
			pendingRestoreEvents.push({
				tab,
				promises
			});

			return;
		}

		let tabId = tab.id;
		
		if (tabs[tabId] != null) return;

		let windowId = tab.windowId;
		let array = getWindow(windowId);

		if (tab.active) {
			if (activeTab[windowId] != null) {
				tabs[activeTab[windowId]].active = false;
			}

			activeTab[windowId] = tabId;
		}

		array.splice(tab.index, 0, tab);
		correctIndexing(windowId, tab.index);
		tabValues[tabId] = {};
		tabs[tabId] = tab;

		if ((await initializeTabValues(tabId)) == false) {
			deleteTab(tabId);
			return;
		}

		await self.onCreated.__notify(tab);
	}

	self.cacheOnMoved = async function (tabId, info) {
		let tab = tabs[tabId];
		if (logging > 0) console.log('[Q] onMoved', tabId, info, tab)
		await processRestoredtabs();
		if (tab == null) return;

		let windowId = tab.windowId;
		let fromIndex = tab.index;
		let toIndex = info.toIndex;

		let array = windows[windowId];

		array.splice(fromIndex, 1);
		array.splice(toIndex, 0, tab);

		correctIndexing(windowId, Math.min(fromIndex, toIndex)
			, Math.max(fromIndex, toIndex) + 1);

		await self.onMoved.__notify(tab, info);
	}

	self.cacheOnRemoved = async function (tabId, info) {
		let tab = tabs[tabId];
		if (logging > 0) console.log('[Q] onRemoved', tabId, info, tab)
		await processRestoredtabs();
		if (tab == null) return;
		let values = tabValues[tabId];
		deleteTab(tabId);

		await self.onRemoved.__notify(tab, info, values);
	}

	self.cacheOnUpdated = async function (id, info, tab) {
		let oldTab = tabs[id];
		if (logging > 1) console.log('[Q] onUpdated', id, info, tab, oldTab)
		await processRestoredtabs();
		if (oldTab == null) return;

		// onUpdated handler may give information considered
		// outdated, esp. following onAttached index correction
		tab.index = oldTab.index;
		tab.windowId = oldTab.windowId;
		swapTabObject(oldTab, tab);

		await self.onUpdated.__notify(tab, info);
	}

	self.get = function (tabId) {
		return tabs[tabId];
	}

	self.getIndexed = function (windowId, index) {
		let array = windows[windowId];
		if (array == null) return null;
		return array[index];
	}

	self.getActive = function (windowId) {
		return tabs[activeTab[windowId]];
	}

	self.forEach = async function (callback, windowId = null, filter = null) {
		let promises = [];
		let iterable;
		if (windowId != null) {
			iterable = windows[windowId];
			if (iterable == null) {
				return;
			}
		}
		else {
			iterable = tabs;
		}

		for (let k in iterable) {
			let tab = iterable[k];
			if (filter != null && filter(tab) == false) continue;
			promises.push(callback(tab));
		}

		await Promise.all(promises);
	}

	self.forEachWindow = async function (callback) {
		let promises = [];

		for (let key in windows) {
			promises.push(callback(Number(key)));
		}

		await Promise.all(promises);
	}

	self.init = async function (initializerCallback = null) {
		if (initialized !== false) return;
		initialized = true;

		if (config.auto) {
			browser.tabs.onActivated.addListener(function (info) {
				if (logging > 1) console.log('[B] onActivated', info)
				queue.do(self.cacheOnActivated, info);
			});

			browser.tabs.onAttached.addListener(function (id, info) {
				if (logging > 0) console.log('[B] onAttached', id, info)
				queue.do(self.cacheOnAttached, id, info);
			});

			browser.tabs.onCreated.addListener(function (tab) {
				if (logging > 0) console.log('[B] onCreated', tab)
				let promises = tabValueKeys.map(k => browser.sessions.getTabValue(tab.id, k))
				queue.do(self.cacheOnCreated, tab, promises, false);
			});

			browser.tabs.onMoved.addListener(function (id, info) {
				if (logging > 0) console.log('[B] onMoved', id, info)
				queue.do(self.cacheOnMoved, id, info);
			});

			browser.tabs.onRemoved.addListener(function (id, info) {
				if (logging > 0) console.log('[B] onRemoved', id, info)
				queue.do(self.cacheOnRemoved, id, info);
			});

			browser.tabs.onUpdated.addListener(function (id, info, tab) {
				if (logging > 1) console.log('[B] onUpdated', id, info, tab)
				queue.do(self.cacheOnUpdated, id, info, tab);
			});
		}

		let allTabs = await browser.tabs.query({});

		allTabs.sort(function(a, b) {
			return a.index - b.index;
		});

		let promises = [];
		let indices = []; 

		allTabs.forEach(function (tab) {
			tabValues[tab.id] = {};
			tabs[tab.id] = tab;
			let array = getWindow(tab.windowId);
			array.push(tab);
			if (tab.active == true) {
				activeTab[tab.windowId] = tab.id;
			}

			if (tabValueKeys.length > 0) {
				promises.push(initializeTabValues(tab.id));
				indices.push(tab.id);
			}
		});

		await Promise.all(promises);

		for (let i = 0; i < indices.length; i++) {
			let result = promises[i];
			if (result) continue;
			let id = indices[i];
			deleteTab(id);
		}

		if (initializerCallback != null) {
			await initializerCallback(self);
		}

		if (config.auto) {
			queue.enable();
		}
	}

	return self;
}
