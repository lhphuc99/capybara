import type { ServerInfo } from '@capybara-devtools/protocol';
import { useState } from 'react';
import type { ConnectionStatus } from '../connection';
import { readPref, writePref } from '../prefs';
import { AttachFlutterBox } from './AttachFlutter';

interface Props {
  status: ConnectionStatus;
  server?: ServerInfo;
}

const PLATFORMS = [
  ['react-native', 'React Native'],
  ['flutter', 'Flutter'],
  ['web', 'Web'],
] as const;
type PlatformTab = (typeof PLATFORMS)[number][0];
const KEY = 'capybara:onboarding-platform';

export function EmptyState({ status, server }: Props) {
  const [platform, setPlatform] = useState<PlatformTab>(() => {
    const saved = readPref(KEY);
    return PLATFORMS.find(([id]) => id === saved)?.[0] ?? 'react-native';
  });
  const choose = (next: PlatformTab) => {
    setPlatform(next);
    writePref(KEY, next);
  };

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

  return (
    <div className="onboarding">
      <div className="waiting">
        <span className="dot wait pulse" /> Waiting for an app to connect
      </div>
      <h1>Open your app</h1>
      <div className="subtabs platform-tabs" role="tablist" aria-label="Platform">
        {PLATFORMS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`platform-${id}`}
            className="tab"
            aria-selected={platform === id}
            aria-controls="platform-panel"
            onClick={() => choose(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div id="platform-panel" role="tabpanel" aria-labelledby={`platform-${platform}`}>
        {platform === 'react-native' ? (
          <ReactNative server={server} />
        ) : platform === 'flutter' ? (
          <Flutter server={server} />
        ) : (
          <Web />
        )}
      </div>
    </div>
  );
}

function ReactNative({ server }: { server?: ServerInfo }) {
  const address = server?.addresses[0];
  return (
    <>
      <p>
        Start Metro on this computer and open a development build on your simulator or phone. Capybara automatically finds
        apps on ports 8081 and 8082 and shows their logs and network requests. No Capybara package or app code changes are
        needed.
      </p>
      <p className="note">
        Requires Hermes and a Metro target that supports multiple debuggers. Network capture depends on your React Native /
        Expo version. For another port, run the CLI with <code>--metro-port 8090</code>. If the CLI uses{' '}
        <code>--no-metro</code>, only SDK connections are shown.
      </p>

      <h2>Storage without an SDK</h2>
      <p>
        Open the Storage tab to browse and edit AsyncStorage and discoverable MMKV instances already loaded by your app. Use
        Refresh to see what the app wrote since. Private MMKV instances may not be discoverable.
      </p>

      <h2>Optional: the React Native SDK</h2>
      <p>
        Install the SDK for the State tab, storage that updates as the app writes it, and instances Metro cannot find. Apps
        with the SDK are skipped by the Metro bridge.
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
        The SDK finds the server through the Metro bundle URL. Android devices on USB are covered by <code>adb reverse</code>,
        which the server runs for you. Install the SDK with <code>npm install @capybara-devtools/react-native</code>.
      </p>
    </>
  );
}

function Flutter({ server }: { server?: ServerInfo }) {
  if (!server?.flutter) {
    return (
      <p>
        This Capybara does not read Flutter apps: it runs with <code>--no-flutter</code>, its Settings turn it off, or it is
        older than Flutter support.
      </p>
    );
  }
  return (
    <>
      <p>
        Run your app in debug mode with <code>flutter run</code> or from your IDE. Capybara finds it on its own and shows its
        logs, Flutter errors and HTTP requests. No package or code changes are needed.
      </p>
      <p className="note">
        Requests sent before Capybara found the app are missing; hot restart it (R) to record them from the start. If the CLI
        uses <code>--no-flutter</code>, Flutter apps are not read.
      </p>
      <AttachFlutterBox />

      <h2>
        Storage and State: the Capybara package for Flutter <span className="soon">Coming soon</span>
      </h2>
      <p>The package adds the Storage and State tabs. It is coming soon to pub.dev; logs, errors and network work without it.</p>
    </>
  );
}

function Web() {
  return (
    <>
      <p>Load the SDK before the rest of your code to capture early logs and requests.</p>
      <pre className="code">{`import { init } from '@capybara-devtools/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });`}</pre>
      <p className="note">
        Install it with <code>npm install @capybara-devtools/web</code>. In Next.js 15.3 and later, call it in{' '}
        <code>instrumentation-client.ts</code>.
      </p>
    </>
  );
}
