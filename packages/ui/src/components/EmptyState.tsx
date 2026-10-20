import type { ServerInfo } from '@capybara-devtools/protocol';
import type { ConnectionStatus } from '../connection';

interface Props {
  status: ConnectionStatus;
  server?: ServerInfo;
}

export function EmptyState({ status, server }: Props) {
  if (status !== 'open') {
    return (
      <div className="onboarding">
        <h1>Connecting to the Capybara server…</h1>
        <p>
          Start it with <code>npx capybara-devtools</code>. This page reconnects on its own.
        </p>
      </div>
    );
  }

  const address = server?.addresses[0];
  return (
    <div className="onboarding">
      <div className="waiting">
        <span className="dot wait pulse" /> Waiting for an app to connect
      </div>
      <h1>Open your React Native app</h1>
      <p>
        Start Metro on this computer and open a development build on your simulator or phone.
        Capybara automatically finds apps on ports 8081 and 8082 and shows their logs and network requests.
        No Capybara package or app code changes are needed.
      </p>
      <p className="note">
        Requires Hermes and a Metro target that supports multiple debuggers. Network capture depends on
        your React Native / Expo version. For another port, run the CLI with <code>--metro-port 8090</code>.
        If the CLI uses <code>--no-metro</code>, only SDK connections are shown.
      </p>

      <h2>Web: connect with the SDK</h2>
      <p>Load the SDK before the rest of your code to capture early logs and requests.</p>
      <pre className="code">{`import { init } from '@capybara-devtools/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });`}</pre>

      <h2>Storage without an SDK</h2>
      <p>
        Open the Storage tab to browse and edit AsyncStorage and discoverable MMKV instances already loaded by your app.
        Use Refresh to see what the app wrote since. Private MMKV instances may not be discoverable.
      </p>

      <h2>Optional: the React Native SDK</h2>
      <p>
        Install the SDK for the State tab, storage that updates as the app writes it, and instances Metro cannot find. Apps with
        the SDK are skipped by the Metro bridge.
      </p>
      <pre className="code">{`import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init } from '@capybara-devtools/react-native';

if (__DEV__) init({ appName: 'My app', storage: [asyncStorage(AsyncStorage)] });`}</pre>

      <p className="note">
        {address ? (
          <>
            Phones on the same Wi-Fi reach this machine at <code>{`${address}:${server?.port}`}</code>.{' '}
          </>
        ) : null}
        The SDK finds the server through the Metro bundle URL. Android devices on USB are covered by{' '}
        <code>adb reverse</code>, which the server runs for you. Install the SDKs with{' '}
        <code>npm install @capybara-devtools/web</code> or <code>npm install @capybara-devtools/react-native</code>.
      </p>
    </div>
  );
}
