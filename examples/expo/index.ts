// No Capybara SDK is loaded: logs and network are collected through Metro.
// Storage can also be read through Metro. To enable SDK storage editing,
// add `import './capybara';` before the imports below.
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
