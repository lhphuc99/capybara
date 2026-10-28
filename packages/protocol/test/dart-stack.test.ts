import { describe, expect, it } from 'vitest';
import {
  dartSourcePath,
  dartStackTop,
  formatDartFrame,
  isFlutterSession,
  parseDartStack,
  readsWithoutSdk,
} from '../src/index.js';

const app = { app: ['shop'] };

// Shaped like what the Dart VM prints for an error thrown while building a widget.
const vmStack = [
  '#0      _CartState.build (package:shop/cart.dart:42:7)',
  '#1      StatefulElement.build (package:flutter/src/widgets/framework.dart:5842:27)',
  '#2      ComponentElement.performRebuild (package:flutter/src/widgets/framework.dart:5734:15)',
  '#3      _rootRun (dart:async/zone.dart:1525)',
  '<asynchronous suspension>',
  '#4      CartNotifier.load.<anonymous closure> (package:shop/state/cart.dart:18:5)',
  '#5      ProviderElement.watch (package:flutter_riverpod/src/core.dart:211:9)',
  '#6      Capybara.run (package:capybara_devtools/src/capybara.dart:30:12)',
  '#7      main (file:///Users/me/shop/lib/main.dart:9:3)',
].join('\n');

describe('parseDartStack', () => {
  it('reads VM frames, with or without a column', () => {
    const lines = parseDartStack(vmStack, app)!;
    expect(lines[0]).toEqual({
      text: '#0      _CartState.build (package:shop/cart.dart:42:7)',
      kind: 'app',
      name: '_CartState.build',
      uri: 'package:shop/cart.dart',
      line: 42,
      column: 7,
    });
    expect(lines[3]).toMatchObject({ kind: 'sdk', uri: 'dart:async/zone.dart', line: 1525 });
    expect(lines[3]?.column).toBeUndefined();
  });

  it('sorts frames into the app, its libraries, Flutter, the Dart SDK and Capybara', () => {
    const kinds = parseDartStack(vmStack, app)!.map((line) => line.kind);
    expect(kinds).toEqual(['app', 'framework', 'framework', 'sdk', 'gap', 'app', 'library', 'internal', 'app']);
  });

  it('does not take packages named flutter_* for the Flutter SDK', () => {
    const lines = parseDartStack('#0      Bloc.add (package:flutter_bloc/src/bloc.dart:9:1)')!;
    expect(lines[0]?.kind).toBe('library');
  });

  it('counts package frames as libraries until it knows the app', () => {
    expect(parseDartStack('#0      main (package:shop/main.dart:1:1)')![0]?.kind).toBe('library');
  });

  it('reads the terse form of package:stack_trace and flutter_test', () => {
    const stack = [
      'package:flutter_test/src/binding.dart 744:19          TestWidgetsFlutterBinding._runTestBody',
      'dart:async                                            _CustomZone.run',
      '===== asynchronous gap ===========================',
      'test/cart_test.dart 42:17                             main.<fn>.<fn>',
    ].join('\n');
    const lines = parseDartStack(stack)!;
    expect(lines.map((line) => line.kind)).toEqual(['framework', 'sdk', 'gap', 'app']);
    expect(lines[0]).toMatchObject({ line: 744, column: 19, name: 'TestWidgetsFlutterBinding._runTestBody' });
    expect(lines[3]).toMatchObject({ uri: 'test/cart_test.dart', name: 'main.<fn>.<fn>' });
  });

  it('reads DDC frames, with the Dart SDK under package:dart-sdk and packages/ URLs', () => {
    const stack = [
      'package:dart-sdk/lib/_internal/js_dev_runtime/private/ddc_runtime/errors.dart 196:49  throw_',
      'packages/shop/cart.dart 4:3                                                          blah',
    ].join('\n');
    const lines = parseDartStack(stack, app)!;
    expect(lines[0]?.kind).toBe('sdk');
    expect(lines[1]).toMatchObject({ kind: 'app', uri: 'package:shop/cart.dart', line: 4, column: 3 });
  });

  it("keeps Flutter's notes on elided frames and stack overflows", () => {
    const stack = [
      '#0      main (package:shop/main.dart:9:3)',
      '(elided one frame from dart:async)',
      '(elided 3 frames from class _AssertionError and dart:async)',
      '...',
    ].join('\n');
    expect(parseDartStack(stack, app)!.map((line) => line.kind)).toEqual(['app', 'elided', 'elided', 'elided']);
  });

  it('marks unsymbolized release traces', () => {
    const stack = [
      '*** *** *** *** *** *** *** *** *** *** *** *** *** *** *** ***',
      "build_id: '5ae4d1d8a3b1fdf43a7ee9e3e7b1c7d2'",
      'isolate_dso_base: 7a3b400000, vm_dso_base: 7a3b400000',
      '#00 abs 000000723d6346d7 virt 00000000001ed6d7 _kDartIsolateSnapshotInstructions+0x1e26d7',
    ].join('\n');
    expect(parseDartStack(stack)!.map((line) => line.kind)).toEqual(['aot', 'aot', 'other', 'aot']);
  });

  it('leaves JS stacks alone', () => {
    expect(parseDartStack('Error: boom\n    at run (http://localhost:8081/index.bundle:1:2)')).toBeUndefined();
    expect(parseDartStack('TypeError: x is undefined\nrun@http://localhost:5173/src/App.tsx:4:9')).toBeUndefined();
    expect(parseDartStack('Error: boom\n    at run (file:///Users/me/app/index.js:3:1)')).toBeUndefined();
  });

  it('does not take prose that names a Dart file or a URL for a stack', () => {
    expect(parseDartStack('package:shop/cart.dart failed to load')).toBeUndefined();
    expect(parseDartStack('https://api.example.com/cart 404 Not Found')).toBeUndefined();
    expect(parseDartStack('<asynchronous suspension>')).toBeUndefined();
  });
});

describe('dartStackTop', () => {
  it("skips Flutter's frames, the SDK's and Capybara's to show where the app was", () => {
    expect(dartStackTop(vmStack, app)).toEqual([
      '_CartState.build (package:shop/cart.dart:42:7)',
      'CartNotifier.load.<anonymous closure> (package:shop/state/cart.dart:18:5)',
      'ProviderElement.watch (package:flutter_riverpod/src/core.dart:211:9)',
    ]);
  });

  it('falls back to the top frames when all of them are folded away', () => {
    const stack = [
      '#0      RenderFlex.performLayout (package:flutter/src/rendering/flex.dart:1012:9)',
      '#1      _rootRun (dart:async/zone.dart:1525:13)',
    ].join('\n');
    expect(dartStackTop(stack, app, 1)).toEqual(['RenderFlex.performLayout (package:flutter/src/rendering/flex.dart:1012:9)']);
  });

  it('is empty for a JS stack', () => {
    expect(dartStackTop('Error: boom\n    at run (http://localhost:8081/index.bundle:1:2)')).toEqual([]);
  });
});

describe('formatDartFrame', () => {
  it('drops the frame number and padding', () => {
    const [line] = parseDartStack('#12     main (package:shop/main.dart:9:3)')!;
    expect(formatDartFrame(line!)).toBe('main (package:shop/main.dart:9:3)');
  });
});

describe('dartSourcePath', () => {
  it('names the file of file: URIs and of packages it knows the folder of', () => {
    expect(dartSourcePath('file:///Users/me/shop%20app/lib/main.dart')).toBe('/Users/me/shop app/lib/main.dart');
    expect(dartSourcePath('package:shop/state/cart.dart', { app: ['shop'], dirs: { shop: '/Users/me/shop/lib/' } })).toBe(
      '/Users/me/shop/lib/state/cart.dart',
    );
    expect(dartSourcePath('package:dio/dio.dart', { app: ['shop'], dirs: { shop: '/Users/me/shop/lib' } })).toBeUndefined();
    expect(dartSourcePath('dart:async/zone.dart')).toBeUndefined();
  });
});

describe('isFlutterSession and readsWithoutSdk', () => {
  const sdk = (name: string) => ({ sdk: { name, version: '0.1.0' } });

  it('tells Flutter apps from the others by the SDK they report', () => {
    expect(isFlutterSession(sdk('dart-vm-service'))).toBe(true);
    expect(isFlutterSession(sdk('capybara_devtools'))).toBe(true);
    expect(isFlutterSession(sdk('@capybara-devtools/react-native'))).toBe(false);
    expect(isFlutterSession(sdk('metro'))).toBe(false);
  });

  it('knows which sessions Capybara reads without an SDK in the app', () => {
    expect(readsWithoutSdk(sdk('metro'))).toBe(true);
    expect(readsWithoutSdk(sdk('dart-vm-service'))).toBe(true);
    expect(readsWithoutSdk(sdk('capybara_devtools'))).toBe(false);
    expect(readsWithoutSdk(sdk('@capybara-devtools/web'))).toBe(false);
  });

  it('does not throw on a session without sdk, which old servers let through', () => {
    expect(isFlutterSession({} as never)).toBe(false);
    expect(readsWithoutSdk({} as never)).toBe(false);
  });
});
