import 'dart:async';
import 'dart:convert';

import 'package:capybara_devtools/src/core/socket.dart';

/// A socket to a pretend Capybara server, which the test plays.
final class FakeSocket implements CapybaraSocket {
  FakeSocket(this.url);

  final Uri url;
  final _incoming = StreamController<String>();
  final List<Map<String, Object?>> sent = [];
  bool closed = false;

  @override
  Stream<String> get messages => _incoming.stream;

  @override
  void send(String data) => sent.add(jsonDecode(data) as Map<String, Object?>);

  @override
  Future<void> close() async {
    closed = true;
    await _incoming.close();
  }

  void receive(Map<String, Object?> message) => _incoming.add(jsonEncode(message));

  /// The server goes away.
  Future<void> drop() => close();

  List<Map<String, Object?>> get events => [
    for (final message in sent)
      if (message['t'] == 'events') ...(message['events']! as List).cast<Map<String, Object?>>(),
  ];
}

/// Hands out a fake socket per connection, or fails while [up] is false.
final class FakeServer {
  final List<FakeSocket> sockets = [];
  final List<String> attempts = [];
  bool up = true;
  final Set<String> refusedHosts = {};
  Object? failure;

  Future<CapybaraSocket> connect(Uri url) async {
    attempts.add(url.host);
    if (failure != null) throw failure!;
    if (!up || refusedHosts.contains(url.host)) throw StateError('Connection refused');
    final socket = FakeSocket(url);
    sockets.add(socket);
    return socket;
  }

  FakeSocket get last => sockets.last;
}
