# @capybara-devtools/core

Client runtime and built-in plugins (console, network, storage, state) shared by the [Capybara](https://github.com/lhphuc99/capybara#readme) SDKs.

To use Capybara in an app, install [`@capybara-devtools/web`](https://www.npmjs.com/package/@capybara-devtools/web) or [`@capybara-devtools/react-native`](https://www.npmjs.com/package/@capybara-devtools/react-native) instead. Both re-export the state adapters from here: `watchZustand`, `watchQueryClient`, `watchSWR`, `swrMiddleware`, `swrProvider`, `capybaraReduxEnhancer` and `connectReduxStore`.
