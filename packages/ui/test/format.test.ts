import { describe, expect, it } from 'vitest';
import { decodeSocketIo } from '../src/format';

describe('decodeSocketIo', () => {
  it('names socket.io packets and pulls out event arguments', () => {
    expect(decodeSocketIo('42["chat",{"text":"hi"}]')).toEqual({ label: 'event "chat"', payload: '{"text":"hi"}' });
    expect(decodeSocketIo('42["typing"]')).toEqual({ label: 'event "typing"', payload: undefined });
    expect(decodeSocketIo('42["move",1,2]')).toEqual({ label: 'event "move"', payload: '[1,2]' });
    expect(decodeSocketIo('4212["save",{"id":3}]')).toEqual({ label: 'event "save" #12', payload: '{"id":3}' });
    expect(decodeSocketIo('42/admin,["kick"]')).toEqual({ label: 'event "kick" in /admin', payload: undefined });
    expect(decodeSocketIo('4312[{"ok":true}]')).toEqual({ label: 'ack #12', payload: '[{"ok":true}]' });
    expect(decodeSocketIo('40{"sid":"abc"}')).toEqual({ label: 'connect', payload: '{"sid":"abc"}' });
    expect(decodeSocketIo('44{"message":"Not authorized"}')).toEqual({ label: 'connect error', payload: '{"message":"Not authorized"}' });
    expect(decodeSocketIo('451-["upload",{"_placeholder":true,"num":0}]')).toEqual({
      label: 'binary event "upload"',
      payload: '{"_placeholder":true,"num":0}',
    });
  });

  it('names engine.io packets and leaves other text alone', () => {
    expect(decodeSocketIo('0{"sid":"x","pingInterval":25000}')).toEqual({ label: 'open', payload: '{"sid":"x","pingInterval":25000}' });
    expect(decodeSocketIo('2')).toEqual({ label: 'ping', payload: undefined });
    expect(decodeSocketIo('3')).toEqual({ label: 'pong', payload: undefined });
    expect(decodeSocketIo('{"type":"hello"}')).toBeUndefined();
    expect(decodeSocketIo('9 lives')).toBeUndefined();
  });
});
