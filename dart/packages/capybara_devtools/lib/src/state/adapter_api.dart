import 'package:flutter/foundation.dart';

import 'engine.dart';
import 'registry.dart';

/// Debug builds only, as the rest of the package; a constant, so release builds drop what calls it.
const bool _enabled = kDebugMode || bool.fromEnvironment('CAPYBARA_ENABLED');

/// Registers a store whose state Capybara records, before or after `Capybara.run`. Null where Capybara does
/// nothing: release builds and the web.
///
/// [library] groups stores in the State tab (`riverpod`, `bloc`); [via] says how they were found (`observer`);
/// [actions] says whether changes come with the name of what made them. [read] gives the current state.
CapybaraStateStore? trackState({
  required String library,
  required String label,
  required String via,
  required bool actions,
  required Object? Function() read,
  String? note,
}) {
  if (!_enabled || kIsWeb) return null;
  return StateRegistry.instance.track(
    library: library,
    label: label,
    via: via,
    actions: actions,
    read: read,
    note: note,
  );
}

/// Sends the `state.*` events of the stores registered from now on, and of those already, to [emit], as if a
/// Capybara server were connected: for the tests of adapter packages. The function returned stops it.
@visibleForTesting
void Function() debugAttachStateEngine(void Function(String kind, Map<String, Object?> payload) emit) {
  final engine = StateEngine((kind, payload, {ts}) => emit(kind, payload), connected: () => true);
  StateRegistry.instance.attach(engine);
  return () {
    StateRegistry.instance.detach(engine);
    engine.dispose();
  };
}
