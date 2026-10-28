# capybara_devtools_riverpod

Shows a Flutter app's Riverpod providers in [Capybara](https://capybara.lhphuc.com)'s State tab, with what each change
did: one store per `ProviderScope`, its state a map from each provider's name to its value.

Works with Riverpod 3, next to [capybara_devtools](https://pub.dev/packages/capybara_devtools), which connects the app
to Capybara.

## Use

```dart
void main() {
  Capybara.run(() {
    WidgetsFlutterBinding.ensureInitialized();
    runApp(const ProviderScope(observers: [CapybaraRiverpodObserver()], child: MyApp()));
  });
}
```

Each provider shows under its `name`: riverpod_generator names them, other providers need `name: '…'` or show as
their type. A family's providers show with their argument, as `todo(42)`. Async values show as `{loading: true}`,
`{data: …}` or `{error: …}`.

In release builds the observer does nothing.
