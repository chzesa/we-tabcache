# Tab caching utility for Firefox
This script can be used to maintain a addon-local copy of the browser tabs' state primarily to avoid performing `browser.tabs.query`, `browser.tabs.get`, and `browser.sessions.getTabValue` function calls.

The script hasn't been tested on chrome.

## Usage
**Depends on [`js-syncqueue`](https://github.com/chzesa/js-syncqueue)** (see Queue).

Required manifest permissions: `tabs`, `sessions`.

The [`tabs.Tab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab) objects that are returned from the cache methods, or passed to the *cache event handlers* must not be mutated.

### Configuration
Creating the cache: `let cache = newCache(myConfig);`

Initializing the cache: `await cache.init(myInitFunction);`

```Js
function myOnCreatedHandler(tab) { /*  */ }

// Example configuration
let myListeners = {
	onCreated: myOnCreatedHandler
};

let myConfig = {
	listeners: myListeners,
	auto: true,
	queue: null,
	tabValueKeys: ['foo', 'bar'],
};
```

The `listeners` object may contain any combination of the following values: `onActivated`, `onAttached`, `onCreated`, `onMoved`, `onRemoved`, and `onUpdated`, corresponding to `browser.tabs` events. The values are registered as *cache event handlers* (see Cache Event Handlers).

`auto` is a boolean which can be used to avoid manually adding the required browser event listeners. If `true`, it will also create the required `queue` object  (see Queue). This may be set as `false` if some browser events are not desired to be listened to, but hooking the cache listeners must be done manually.

`queue` is required only when configuration doesn't have `auto: true`. The value is the `js-syncqueue` object used for processing asynchronous browser events in a synchronous manner.

`tabValueKeys` is an array of keys (strings) used for the `sessions` api tabValue functions. Values for keys defined in the array are fetched and stored by the cache. This prefetching occurs when initializing the cache itself and in the cache onCreated handler. The fetched values are guaranteed to be available in the cache for `myInitFunction` and `onCreated` cache event handler functions.

### Cache Events
The cache object has `onActivated`, `onAttached`, `onCreated`, `onMoved`, `onRemoved`, and `onUpdated` keys which provide a similar interface as the corresponding `browser.tabs` events. Each key supports the following:

* `addListener(myListenerFunction)`: the function passed as a parameter will be invoked by the cache as described in the *Cache Event Handlers* section.
* `removeListener(myListenerFunction)`: removes the specified function from the list of functions invoked when the event is fired.
* `hasListener(myListenerFunction)`: returns `true` if the parameter is currently registered as a listener of the event, `false` otherwise.

### Cache Event Handlers
The *cache event handlers* are the functions passed to the cache in the `listeners` object, and any function that was added as a listener for one of the cache events. They will be invoked after the cache state has been updated following a browser event. They may be asynchronous and will be awaited on before the cache continues processing further browser events.

* `onActivated` will be invoked with arguments `tabs.Tab`, [`activeInfo`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onActivated#activeInfo).
* `onAttached` will be invoked with arguments `tabs.Tab`, [`attachInfo`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onAttached#attachInfo). **There will not be a corresponding `onDetached` event**. Instead, the `attachInfo` contains the values of the [`detachInfo`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onDetached#detachInfo) and the cache will immediately reflect the browser state after the `onDetached` event. In addition, the cache will re-submit any cached tabValues before invoking the cache event handlers.
* `onCreated` will be invoked with the argument `tabs.Tab`. Any values (if defined) for keys in `tabValueKeys` will be available in the cache before the cache event handlers are invoked. If prefetching one of the values fails the cache will not invoke any events related to the tab, as the tab will have been closed.
* `onMoved` will be invoked with the arguments `tabs.Tab`, [`moveInfo`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onMoved#moveInfo).
* `onRemoved` will be invoked with arguments `tabs.Tab`, [`removeInfo`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/onRemoved#removeInfo), `values`. `values` is an object consisting of the key-value pairs which were present in the cache when the tab was removed. **The values may not correspond to the actual values stored by the browser**, for example, when the cache values were updated after a tab was removed.
* `onUpdated` will be invoked with arguments `tabs.Tab`, [`updateProperties`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/update).

### Methods
#### tabValues
* `cache.setValue(tabId, key, value)` will store a tabValue in the cache. If the argument value doesn't match the currently cached value then `browser.sessions` tabValue will be updated.
* `cache.getValue(tabId, key)` returns the cached tabValue. If the cache was configured with `tabValueKeys` any keys for which there is a defined value will be available in the cache, otherwise the value must be stored manually with the `setValue` function.
* `cache.removeValue(tabId, key)` removes a value from the cache and `browser.sessions`.

#### Tab queries
* `cache.get(tabId)` returns the corresponding `tabs.Tab` object in the cache.
* `cache.getIndexed(windowId, index)` returns the corresponding `tabs.Tab` object in the cache.
* `cache.getActive(windowId)` returns the `tabs.Tab` of the active tab in the window.

#### Iterating
* `cache.forEach(callback, windowId, filter)` (asynchronous) will invoke `callback` for every cached tab, passing the `tabs.Tab` object as the only argument. If `windowId` is defined, only tabs in the specified window are iterated. If defined, `filter` will be invoked for every iterated tab with the `tabs.Tab` as the only argument. If `filter` returns a value that coerces to `false` the `callback` will not be invoked for that tab. `callback` may be asynchronous, and will be awaited on as a group.
* `cache.forEachWindow(callback)` (asynchronous) will invoke `callback` for every cached window, passing the `windowId` value as the only argument. `callback` may be asynchronous, and will be awaited on as a group.

#### Other
* `cache.init(myInitFunction)` (asynchronous) causes the cache to initialize, querying for the current tab data from the browser, updating its internal state, invoking `myInitFunction` function with the cache itself as the parameter, and finally beginning to process browser events. `myInitFunction` is optional, may be asynchronous, and will be awaited on.
* `cache.debug()` returns an object containing the internal variables in the cache.

## Known intentional behaviour differences to Firefox
* The cache event handlers for `tabs.onUpdated` will not be invoked before the `tabs.onCreated` event for a given tab.
* The `index` and `windowId` of `tabs.Tab` passed to `onUpdated` cache event handler may differ from the values given to the `tabs.onUpdated` event callback, particularly when tabs are moved from one window to another.

## Queue
Internally the script maintains a [`js-syncqueue`](https://github.com/chzesa/js-syncqueue) object to queue pending browser events while its internal state is updating and the cache event handlers are being awaited on. This also guarantees all browser events are handled, even the ones occurring during cache initialization.

`src.js` of `js-syncqueue` must be in scope when using `auto:true`.

Accessing the queue when using `auto: true` can be done via `let cacheQueue = cache.debug().queue` as soon as the cache has been created (not necessarily initialized).

## `auto: false`
For the cache to function correctly, at least the `cache.cacheOnCreated`, `cache.cacheOnRemoved`, `cache.ocacheOnMoved`, and `cache.cacheOnAttached` listeners must be hooked to the corresponding browser events.

```Js
let myQueue = newSyncQueue({ enabled: false });
let cache = newCache({ myQueue });

browser.tabs.onCreated.addEventListener(info => {
	myQueue.do(cache.cacheOnCreated, info);
});

/* other listeners */

await cache.init(myInitFunction);
````

## Examples
[ftt](https://github.com/chzesa/ftt)

[Tiled Tab Groups](https://github.com/chzesa/tiled-tab-groups)