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

function newCache(config = {}) {
	config.listeners = config.listeners === undefined ? {} : config.listeners;

	const self = {};
	const windows = {};
	const tabs = {};
	const activeTab = {};
	const tabValues = {};

	const onActivated = config.listeners.onActivated;
	const onAttached = config.listeners.onAttached;
	const onCreated = config.listeners.onCreated;
	const onMoved = config.listeners.onMoved;
	const onRemoved = config.listeners.onRemoved;
	const onUpdated = config.listeners.onUpdated;

	const tabValueKeys = config.tabValueKeys || [];
	let queue;
	let initialized = false;

	if (config.auto) {
		queue = newSyncQueue({
			enabled: false
		});
	}
	
	self.debug = function () {
		let ret = {windows, tabs, activeTab};
		if (queue != null) ret.queue = queue;
		return ret;
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

		return null;
	}

	self.removeValue = function(tabId, key) {
		let values = tabs[tabId];
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

	self.onActivated = async function (info) {
		let tabId = info.tabId;
		let tab = tabs[tabId];
		if (tab == null) return;
		let windowId = tab.windowId;
		let oldTab = tabs[activeTab[windowId]];
		if (oldTab != null) {
			oldTab.active = false;
		}

		activeTab[windowId] = tabId;
		tab.active = true;

		if (onActivated != null) {
			await onActivated(tab, info);
		}
	}

	self.onAttached = async function (tabId, info) {
		let tab = tabs[tabId];
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

		if (onAttached != null) {
			await onAttached(tab, info);
		}
	}

	self.onCreated = async function (tab) {
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

		if (onCreated != null) {
			await onCreated(tab);
		}
	}

	self.onMoved = async function (tabId, info) {
		let tab = tabs[tabId];
		if (tab == null) return;

		let windowId = tab.windowId;
		let fromIndex = tab.index;
		let toIndex = info.toIndex;

		let array = windows[windowId];

		array.splice(fromIndex, 1);
		array.splice(toIndex, 0, tab);

		correctIndexing(windowId, Math.min(fromIndex, toIndex)
			, Math.max(fromIndex, toIndex) + 1);

		if (onMoved != null) {
			await onMoved(tab, info);
		}
	}

	self.onRemoved = async function (tabId, info) {
		let tab = tabs[tabId];
		if (tab == null) return;
		let values = tabValues[tabId];
		deleteTab(tabId);

		if (onRemoved != null) {
			await onRemoved(tab, info, values);
		}
	}

	self.onUpdated = async function (id, info, tab) {
		let oldTab = tabs[id];
		if (oldTab == null) return;

		// onUpdated handler may give information considered
		// outdated, esp. following onAttached index correction
		tab.index = oldTab.index;
		tab.windowId = oldTab.windowId;
		swapTabObject(oldTab, tab);

		if (onUpdated != null) {
			await onUpdated(tab, info);
		}
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

	self.init = async function () {
		if (initialized !== false) return;
		initialized = true;

		if (config.auto) {
			browser.tabs.onActivated.addListener(function (info) {
				queue.do(self.onActivated, info);
			});

			browser.tabs.onAttached.addListener(function (id, info) {
				queue.do(self.onAttached, id, info);
			});

			browser.tabs.onCreated.addListener(function (tab) {
				queue.do(self.onCreated, tab);
			});

			browser.tabs.onMoved.addListener(function (id, info) {
				queue.do(self.onMoved, id, info);
			});

			browser.tabs.onRemoved.addListener(function (id, info) {
				queue.do(self.onRemoved, id, info);
			});

			browser.tabs.onUpdated.addListener(function (id, info, tab) {
				queue.do(self.onUpdated, id, info, tab);
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

		if (config.init != null) {
			await config.init(self);
		}

		if (config.auto) {
			queue.enable();
		}
	}

	return self;
}
