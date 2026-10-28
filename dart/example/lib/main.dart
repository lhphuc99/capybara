import 'dart:async';

import 'package:capybara_devtools/capybara_devtools.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hive_ce_flutter/hive_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'actions.dart';
import 'state.dart';

/// `--dart-define=CAPYBARA_SDK=true` runs the app with the Capybara package. Without it Capybara reads the app
/// through the Dart VM service alone, as it does apps that do not have the package.
const bool capybaraSdk = bool.fromEnvironment('CAPYBARA_SDK');

void main() {
  if (capybaraSdk) {
    Capybara.run(_start, options: const CapybaraOptions(appName: 'Capybara example'));
  } else {
    unawaited(_start());
  }
}

Future<void> _start() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Hive.initFlutter();
  // Without Capybara running, these only keep the stores at hand.
  Capybara.addStorage(CapybaraHiveBox(await Hive.openBox<Object>('settings')));
  Capybara.addStorage(CapybaraSharedPreferences.legacy(await SharedPreferences.getInstance()));
  Capybara.addStorage(CapybaraSecureStorage(const FlutterSecureStorage()));
  setUpState();
  registerExampleExtensions();
  runApp(const ExampleApp());
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Capybara example',
      theme: ThemeData(colorSchemeSeed: const Color(0xFFF2A33A), useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: const Color(0xFFF2A33A), brightness: Brightness.dark, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

const _sections = {
  'Logs': ['log.print', 'log.debugPrint', 'log.developer', 'log.capybara', 'log.burst'],
  'Errors': ['error.build', 'error.assert', 'error.overflow', 'error.async'],
  'HTTP': ['http.images'],
  'WebSocket': ['ws.echo'],
  'Storage': ['storage.prefs', 'storage.secure', 'storage.hive'],
  'State': ['state.counter', 'state.cart', 'state.clear', 'state.theme', 'state.settings'],
};

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder(
      valueListenable: breakage,
      builder: (context, broken, _) {
        if (broken == 'build') throw StateError('The cart failed to build');
        assert(broken != 'assert', 'The cart is in a state it should never be in');
        return Scaffold(
          appBar: AppBar(title: const Text('Capybara example')),
          body: broken == 'overflow'
              ? Row(children: [Text('This row is far too wide for any screen. ' * 8)])
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    ValueListenableBuilder(
                      valueListenable: status,
                      builder: (context, text, _) => Text(text, style: Theme.of(context).textTheme.bodySmall),
                    ),
                    for (final MapEntry(key: title, value: ids) in _sections.entries) ...[
                      _Heading(title),
                      _Buttons(ids),
                      if (title == 'HTTP')
                        for (final client in httpClients) ...[
                          Text(client, style: Theme.of(context).textTheme.labelLarge),
                          _Buttons([for (final request in httpRequests) 'http.$client.$request']),
                        ],
                    ],
                  ],
                ),
        );
      },
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 20, bottom: 8),
      child: Text(title, style: Theme.of(context).textTheme.titleMedium),
    );
  }
}

class _Buttons extends StatelessWidget {
  const _Buttons(this.ids);

  final List<String> ids;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final id in ids) OutlinedButton(onPressed: () => run(id, actions[id]!), child: Text(id.split('.').last)),
      ],
    );
  }
}
