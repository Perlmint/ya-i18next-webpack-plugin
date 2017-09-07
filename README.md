[![npm version](https://badge.fury.io/js/ya-i18next-webpack-plugin.svg)](https://badge.fury.io/js/ya-i18next-webpack-plugin)
[![dependencies Status](https://david-dm.org/perlmint/ya-i18next-webpack-plugin/status.svg)](https://david-dm.org/perlmint/ya-i18next-webpack-plugin)
[![devDependencies Status](https://david-dm.org/perlmint/ya-i18next-webpack-plugin/dev-status.svg)](https://david-dm.org/perlmint/ya-i18next-webpack-plugin?type=dev)
# ya-i18next-webpack-plugin

Yet another i18next webpack plugin

This plugin collects keys from webpack parsing phase, saves missing translations into specified path, copies translation files.

## usage

### webpack.config.js
```js
const i18nextPlugin = require("ya-i18next-webpack-plugin").default;

module.exports = {
    plugins: [
        new i18nextPlugin({
            defaultLanguage: "en",
            languages: ["en", "ko"],
            functionName: "_t",
            resourcePath: "./locales/{{lng}}/{{ns}}.json",
            pathToSaveMissing: "./locales/{{lng}}/{{ns}}-missing.json"
        })
    ]
};
```

### index.js
```js
import * as i18next from 'i18next';
import * as Backend from 'i18next-xhr-backend';
import * as i18nConf from "ya-i18next-webpack-plugin/config";

if (window._t === undefined) {
	i18next
		.use(Backend)
		.init({
			fallbackLng: i18nConf.DEFAULT_NAMESPACE,
			whitelist: i18nConf.LANGUAGES,
			backend: {
				loadPath: `${__webpack_public_path__}${i18nConf.RESOURCE_PATH}`
			}
		});
	window._t = i18next.t;
}

console.log(_t("hello_world"));
```

## example missing keys

```json
{
	"hello_world": [
		"index.js(18,16)"
	],
}
```