import type { ServerInfo } from '@devsight/protocol';
import type { ConnectionStatus } from '../connection';

interface Props {
  status: ConnectionStatus;
  server?: ServerInfo;
}

export function EmptyState({ status, server }: Props) {
  if (status !== 'open') {
    return (
      <div className="onboarding">
        <h1>Connecting to the Devsight server…</h1>
        <p>
          Start it with <code>npx devsight</code>. This page reconnects on its own.
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
        Devsight automatically finds apps on ports 8081 and 8082 and shows their logs and network requests.
        No Devsight package or app code changes are needed.
      </p>
      <p className="note">
        Requires Hermes and a Metro target that supports multiple debuggers. Network capture depends on
        your React Native / Expo version. For another port, run the CLI with <code>--metro-port 8090</code>.
        If the CLI uses <code>--no-metro</code>, only SDK connections are shown.
      </p>

      <h2>Web: connect with the SDK</h2>
      <p>Load the SDK before the rest of your code to capture early logs and requests.</p>
      <pre className="code">{`import { init } from '@devsight/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });`}</pre>

      <h2>Storage without an SDK</h2>
      <p>
        Open the Storage tab to browse AsyncStorage and discoverable MMKV instances already loaded by your app.
        This connection is read-only; use Refresh to see new values. Private MMKV instances may not be discoverable.
      </p>

      <h2>Optional: edit React Native storage</h2>
      <p>Install the SDK for storage editing and explicitly configured instances. Apps with the SDK are skipped by the Metro bridge.</p>
      <pre className="code">{`import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init } from '@devsight/react-native';

if (__DEV__) init({ appName: 'My app', storage: [asyncStorage(AsyncStorage)] });`}</pre>

      <p className="note">
        {address ? (
          <>
            Phones on the same Wi-Fi reach this machine at <code>{`${address}:${server?.port}`}</code>.{' '}
          </>
        ) : null}
        The SDK finds the server through the Metro bundle URL. Android devices on USB are covered by{' '}
        <code>adb reverse</code>, which the server runs for you. The SDK packages are not published yet;
        install them from this workspace or local package archives.
      </p>
    </div>
  );
}
