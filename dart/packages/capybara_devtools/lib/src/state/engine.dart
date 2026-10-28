import 'dart:async';
import 'dart:convert';

import '../core/serialize.dart';

typedef StateEmit = void Function(String kind, Map<String, Object?> payload, {int? ts});

// The JS SDK's limits, so the UI shows the same of both.
const int _maxOps = 100;
const int _maxDepth = 12;
const int _maxNodes = 5000;
const int _maxRead = 128 * 1024;
const Duration _recordDelay = Duration(milliseconds: 100);
const Duration _offlinePoll = Duration(seconds: 1);
const int _queueLimit = 200;
const SerializeOptions _preview = SerializeOptions(
  maxDepth: 3,
  maxKeys: 20,
  maxItems: 20,
  maxString: 200,
  maxNodes: 200,
);
const List<SerializeOptions> _reads = [
  SerializeOptions(maxDepth: 8, maxKeys: 500, maxItems: 500, maxString: 10000, maxNodes: 20000),
  SerializeOptions(maxDepth: 5, maxKeys: 200, maxItems: 200, maxString: 2000, maxNodes: 5000),
  SerializeOptions(maxDepth: 3, maxKeys: 100, maxItems: 100, maxString: 500, maxNodes: 1000),
  SerializeOptions(maxDepth: 1, maxKeys: 50, maxItems: 50, maxString: 200, maxNodes: 100),
];

/// What a state is made of, as the diff and reads walk it: a map's entries, a list's items, the fields of an object
/// that has `toJson()` (as json_serializable and freezed make) or Equatable's `props`. Anything else is a leaf.
Object? _children(Object? value) {
  switch (value) {
    case null || num() || String() || bool():
      return null;
    case Map():
      return value;
    case List():
      return value;
    case Set():
      return value.toList(growable: false);
  }
  try {
    final json = (value as dynamic).toJson();
    if (json is Map || json is List) return json;
  } catch (_) {
    // not JSON-able
  }
  try {
    final props = (value as dynamic).props;
    if (props is List) return props;
  } catch (_) {
    // not Equatable
  }
  return null;
}

bool _equal(Object? a, Object? b) {
  try {
    return a == b;
  } catch (_) {
    return false;
  }
}

/// The changes from [prev] to [next], as `state.change` ops: an identical branch is skipped whole, so the cost
/// follows what changed; ops past 100 are only counted.
({List<Map<String, Object?>> ops, int opCount}) diffState(Object? prev, Object? next) {
  final ops = <Map<String, Object?>>[];
  var opCount = 0;
  var nodes = 0;

  void push(String op, List<Object> path, Object? before, Object? after) {
    opCount++;
    if (ops.length >= _maxOps) return;
    ops.add({
      'op': op,
      'path': path,
      if (op != 'del') 'value': serialize(after, _preview),
      if (op != 'add') 'prev': serialize(before, _preview),
    });
  }

  void walk(Object? a, Object? b, List<Object> path, int depth) {
    final before = _children(a);
    final after = _children(b);
    final bothLists = before is List && after is List;
    final bothMaps = before is Map && after is Map;
    // Leaves, such as two DateTimes, may be equal without being the same object.
    if (before == null && after == null && _equal(a, b)) return;
    if ((!bothLists && !bothMaps) || depth >= _maxDepth || nodes >= _maxNodes) {
      push('set', path, a, b);
      return;
    }
    nodes++;
    if (bothLists) {
      final shared = before.length < after.length ? before.length : after.length;
      for (var i = 0; i < shared; i++) {
        if (!identical(before[i], after[i])) walk(before[i], after[i], [...path, i], depth + 1);
      }
      for (var i = shared; i < after.length; i++) {
        push('add', [...path, i], null, after[i]);
      }
      for (var i = shared; i < before.length; i++) {
        push('del', [...path, i], before[i], null);
      }
      return;
    }
    final x = before! as Map;
    final y = after! as Map;
    for (final key in y.keys) {
      final segment = _segment(key);
      if (!x.containsKey(key)) {
        push('add', [...path, segment], null, y[key]);
      } else if (!identical(x[key], y[key])) {
        walk(x[key], y[key], [...path, segment], depth + 1);
      }
    }
    for (final key in x.keys) {
      if (!y.containsKey(key)) push('del', [...path, _segment(key)], x[key], null);
    }
  }

  if (!identical(prev, next)) {
    try {
      walk(prev, next, const [], 0);
    } catch (_) {
      // A getter threw midway: report the whole state as replaced instead.
      ops.clear();
      opCount = 0;
      push('set', const [], prev, next);
    }
  }
  return (ops: ops, opCount: opCount);
}

Object _segment(Object? key) => key is int ? key : '$key';

/// Follows [path] from [root] the way [diffState] walks it. Paths come through JSON, so a map's int key may arrive
/// as text and the other way round.
({bool found, Object? value}) readPath(Object? root, List<Object?> path) {
  Object? current = root;
  for (final key in path) {
    final children = _children(current);
    if (children is List) {
      final index = key is int ? key : int.tryParse('$key');
      if (index == null || index < 0 || index >= children.length) return (found: false, value: null);
      current = children[index];
    } else if (children is Map) {
      final match = children.containsKey(key)
          ? key
          : children.keys.cast<Object?>().firstWhere((k) => '$k' == '$key', orElse: () => _missing);
      if (identical(match, _missing)) return (found: false, value: null);
      current = children[match];
    } else {
      return (found: false, value: null);
    }
  }
  return (found: true, value: current);
}

const Object _missing = Object();

final class _Change {
  _Change(this.state, this.action, this.cause, this.ts);

  final Object? state;
  final Map<String, Object?>? action;
  final String cause;
  final int ts;
  int skipped = 0;
}

final class _Tracked {
  _Tracked(this.info, this.read);

  final Map<String, Object?> info;
  final Object? Function() read;
  int rev = 0;
  Object? base;
  bool based = false;
  List<_Change> queue = [];
  int windowStart = 0;
  int windowCount = 0;
}

/// Turns what stores report into `state.store` and `state.change` events, and answers reads. Recording only queues
/// a reference; diffing, serializing and sending wait for a timer, and happen only while connected.
final class StateEngine {
  StateEngine(this._emit, {required bool Function() connected, int maxPerSecond = 30})
    : _connected = connected,
      _perSecond = maxPerSecond < 1 ? 1 : maxPerSecond;

  final StateEmit _emit;
  final bool Function() _connected;
  final int _perSecond;
  final Map<String, _Tracked> _stores = {};
  Timer? _timer;
  DateTime? _timerAt;
  bool _offline = false;
  bool _disposed = false;

  void track(String id, Map<String, Object?> info, Object? Function() read) {
    if (_disposed || _stores.containsKey(id)) return;
    final tracked = _Tracked({...info, 'id': id}, read);
    _stores[id] = tracked;
    _emit('state.store', {'store': tracked.info});
    try {
      tracked
        ..base = read()
        ..based = true;
    } catch (_) {
      // The first record becomes the base instead.
    }
  }

  void untrack(String id, {String? note}) {
    final tracked = _stores.remove(id);
    if (tracked == null) return;
    _emit('state.store', {
      'store': {...tracked.info, 'disposed': true, 'note': ?note},
    });
  }

  /// [action] names what changed the state: `{type, payload?}`, with the payload already a preview.
  void record(String id, Object? state, {Map<String, Object?>? action, String? cause}) {
    final tracked = _stores[id];
    if (tracked == null || _disposed) return;
    final change = _Change(
      state,
      action,
      cause ?? (action == null ? 'set' : 'action'),
      DateTime.now().millisecondsSinceEpoch,
    );
    if (tracked.queue.length < _queueLimit) {
      tracked.queue.add(change);
    } else {
      change.skipped = tracked.queue.last.skipped + 1;
      tracked.queue.last = change;
    }
    _wake(_offline ? _offlinePoll : _recordDelay);
  }

  List<Map<String, Object?>> stores() => [for (final tracked in _stores.values) tracked.info];

  Map<String, Object?> read(String id, List<Object?> path) {
    final tracked = _stores[id];
    if (tracked == null) throw StateError('Unknown store "$id"');
    final state = tracked.read();
    final found = readPath(state, path);
    if (!found.found) throw StateError('Nothing at ${jsonEncode(path)}');
    return {'rev': tracked.rev, 'pending': !identical(state, tracked.base), ..._fit(found.value)};
  }

  String label(String id) {
    final tracked = _stores[id];
    if (tracked == null) throw StateError('Unknown store "$id"');
    return '${tracked.info['label']}';
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    _stores.clear();
  }

  static Map<String, Object?> _fit(Object? value) {
    for (var i = 0; i < _reads.length; i++) {
      final out = serialize(value, _reads[i]);
      if (jsonEncode(out).length <= _maxRead) return {'value': out, 'truncated': i > 0};
    }
    return {
      'value': {r'$t': 'limit', 'name': value is List ? 'List(${value.length})' : '${value.runtimeType}'},
      'truncated': true,
    };
  }

  void _wake(Duration delay) {
    if (_disposed) return;
    final at = DateTime.now().add(delay);
    final current = _timerAt;
    if (_timer != null && current != null && !current.isAfter(at)) return;
    _timer?.cancel();
    _timerAt = at;
    _timer = Timer(delay, _flush);
  }

  void _flush() {
    _timer = null;
    _timerAt = null;
    if (_disposed) return;
    var live = false;
    try {
      live = _connected();
    } catch (_) {
      // counts as offline
    }
    _offline = !live;
    final now = DateTime.now().millisecondsSinceEpoch;
    int? next;
    for (final tracked in [..._stores.values]) {
      try {
        _flushChanges(tracked, live, now);
      } catch (_) {
        tracked.queue = [];
      }
      if (tracked.queue.isNotEmpty) {
        final due = live ? tracked.windowStart + 1000 : now + _offlinePoll.inMilliseconds;
        next = next == null || due < next ? due : next;
      }
    }
    if (next != null) _wake(Duration(milliseconds: next - now < 0 ? 0 : next - now));
  }

  static List<_Change> _fold(List<_Change> changes) {
    if (changes.length <= 1) return changes;
    final last = changes.last;
    for (var i = 0; i < changes.length - 1; i++) {
      last.skipped += changes[i].skipped + 1;
    }
    return [last];
  }

  void _flushChanges(_Tracked tracked, bool live, int now) {
    if (tracked.queue.isEmpty) return;
    // Offline, nothing is diffed: changes only pile up as a count on the newest one.
    if (!live) {
      tracked.queue = _fold(tracked.queue);
      return;
    }
    if (now - tracked.windowStart >= 1000) {
      tracked
        ..windowStart = now
        ..windowCount = 0;
    }
    final room = _perSecond - tracked.windowCount;
    if (room <= 0) {
      tracked.queue = _fold(tracked.queue);
      return;
    }
    final queue = tracked.queue;
    tracked.queue = [];
    // The last record of the window carries everything past the limit, so the newest state still goes out.
    final batch = queue.length > room ? [...queue.sublist(0, room - 1), ..._fold(queue.sublist(room - 1))] : queue;
    for (final change in batch) {
      _send(tracked, change);
    }
  }

  void _send(_Tracked tracked, _Change change) {
    // A store's first state shows whole, as its first line in the timeline.
    final diff = tracked.based && change.cause != 'init'
        ? diffState(tracked.base, change.state)
        : (
            ops: [
              {'op': 'set', 'path': const <Object>[], 'value': serialize(change.state, _preview)},
            ],
            opCount: 1,
          );
    tracked
      ..base = change.state
      ..based = true;
    if (diff.ops.isEmpty && change.action == null && change.skipped == 0 && change.cause != 'init') return;
    tracked.windowCount++;
    _emit('state.change', {
      'store': tracked.info['id'],
      'rev': ++tracked.rev,
      'cause': change.cause,
      'action': ?change.action,
      'ops': diff.ops,
      if (diff.opCount > diff.ops.length) 'opCount': diff.opCount,
      if (change.skipped > 0) 'skipped': change.skipped,
    }, ts: change.ts);
  }
}
