# capybara_devtools_bloc

Shows a Flutter app's blocs and cubits in [Capybara](https://capybara.lhphuc.com)'s State tab: one store per
instance, a bloc's changes named after the event that made them.

Works with bloc 9, next to [capybara_devtools](https://pub.dev/packages/capybara_devtools), which connects the app to
Capybara.

## Use

```dart
void main() {
  Capybara.run(() {
    WidgetsFlutterBinding.ensureInitialized();
    Bloc.observer = CapybaraBlocObserver(parent: Bloc.observer);
    runApp(const MyApp());
  });
}
```

`parent` keeps the observer the app had: Capybara's passes every call on to it.

States show as their fields when they have `toJson()` (json_serializable, freezed) or Equatable's `props`, otherwise as
their `toString()`; events show the same way under their type. A closed bloc shows as closed.

In release builds the observer only passes calls on to `parent`.
