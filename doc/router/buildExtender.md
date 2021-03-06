<a name="module_router"></a>

## router : <code>object</code>
Build extender for Router

**Author**: Alper Ozisik <alper.ozisik@smartface.io>  
**Copyright**: Smartface 2019  

* [router](#module_router) : <code>object</code>
    * [~buildExtender(options)](#module_router..buildExtender) ⇒ <code>function</code>
        * [.preProcessors](#module_router..buildExtender.preProcessors)
        * [.postProcessors](#module_router..buildExtender.postProcessors)

<a name="module_router..buildExtender"></a>

### router~buildExtender(options) ⇒ <code>function</code>
Generates build method for Router - Route.
Page constructor is called with the following arguments in order: pageProps, match, routeData, router, route.
Page(s) created with this function will have additional several properties: match, routeData, router, pageName, route

**Kind**: inner method of [<code>router</code>](#module_router)  
**Returns**: <code>function</code> - build function for Route  
**Access**: public  

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| options | <code>object</code> |  | buildExtender configurator |
| options.pageName | <code>string</code> |  | name of the js file within the `pages` folder. This parameter is both page name as well as file name |
| [options.singleton] | <code>boolean</code> | <code>false</code> | Same instance of the page will be used again and again for the same route. It is advised to use a singleton page for each first Route of a StackRouter |
| [options.onHide] | <code>function</code> |  | Extends an onHide event for the page |
| [options.onShow] | <code>function</code> |  | Extends an onShow event for the page |
| [options.onLoad] | <code>function</code> |  | Extends an onLoad event for the page |
| [options.headerBarStyle] | <code>object</code> | <code>{}</code> | iOS only feature. Assigns several properties to the headerBar; some of them the the controller of the StackRouter:Controller  (visible), some of them to the page.headerBar:NavigationItem (leftItemEnabled, largeTitleDisplayMode) at the onShow event of the page |
| [options.preProcessor] | <code>function</code> |  | Event before the page instance is created. Useful when modifying route params before the instance is created. Callback function is called with the following arguments: match, routeData, router, view, pageProps, route |
| [options.postProcessor] | <code>function</code> |  | Event after the page instance is created. Useful when modifying page. Callback function is called with the following arguments: match, routeData, router, pageInstance, pageProps, route |
| [options.pageProps] | <code>object</code> | <code>{}</code> | Properties to be assigned to the page instance |
| [options.pageProps.shouldExit] | <code>boolean</code> |  | When used with goBack, on that page Application.exit is called instead of goBack or dismiss |

**Example**  
```js
const buildExtender = require("sf-extension-utils/lib/router/buildExtender");
var btb = BottomTabBarRouter.of({
    path: "/nav/tabs",
    to: "/nav/tabs/discover/landing",
    tabbarParams: () => styling.tabStyle,
    items: () => tabbarItems,
    routes: [
        StackRouter.of({
            path: "/nav/tabs/discover",
            to: "/nav/tabs/discover/landing",
            homeRoute: 0,
            headerBarProps: () => ({ visible: false }),
            routes: [
                Route.of({
                    path: "/nav/tabs/discover/landing",
                    build: buildExtender({
                        pageName: "pgLandingMain",
                        singleton: true,
                        headerBarStyle: { visible: false },
                        onLoad: setBackBarButtonItem
                    })
                }),
                Route.of({
                    path: "/nav/tabs/discover/l2",
                    build: buildExtender({
                        pageName: "pgLandingL2",
                        headerBarStyle: { visible: true },
                    })
                }),
                Route.of({
                    path: "/nav/tabs/discover/products/:categoryId",
                    build: buildExtender({
                        pageName: "pgProductListing",
                        headerBarStyle: { visible: true },
                    })
                })
            ]
        })
    ]
});
```

* [~buildExtender(options)](#module_router..buildExtender) ⇒ <code>function</code>
    * [.preProcessors](#module_router..buildExtender.preProcessors)
    * [.postProcessors](#module_router..buildExtender.postProcessors)

<a name="module_router..buildExtender.preProcessors"></a>

#### buildExtender.preProcessors
Gets or sets the list of preProcessors running for each page. Callback(s) are called with the following arguments: match, routeData, router, view, pageProps, route

**Kind**: static property of [<code>buildExtender</code>](#module_router..buildExtender)  
**Properties**

| Name | Type |
| --- | --- |
| buildExtender.preProcessors | <code>Array.&lt;function()&gt;</code> | 

**Example**  
```js
const buildExtender = require("sf-extension-utils/lib/router/buildExtender");
buildExtender.preProcessors.push((match, routeData, router, view, pageProps, route) => {
 //
});
```
<a name="module_router..buildExtender.postProcessors"></a>

#### buildExtender.postProcessors
Gets or sets the list of postProcessors running for each page. Callback(s) are called with the following arguments: match, routeData, router, pageInstance, pageProps, route

**Kind**: static property of [<code>buildExtender</code>](#module_router..buildExtender)  
**Properties**

| Name | Type |
| --- | --- |
| buildExtender.postProcessors | <code>Array.&lt;function()&gt;</code> | 

**Example**  
```js
const buildExtender = require("sf-extension-utils/lib/router/buildExtender");
buildExtender.postProcessors.push((match, routeData, router, pageInstance, pageProps, route) => {
 //
});
```
