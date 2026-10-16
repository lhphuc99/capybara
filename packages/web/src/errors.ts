import type { Plugin } from '@capybara-devtools/core';

export function windowErrorsPlugin(): Plugin {
  return {
    name: 'errors',
    setup(ctx) {
      // Bubbling listener only: resource load failures (broken <img>) don't bubble and stay out.
      const onError = (event: ErrorEvent) => {
        const args =
          event.error !== undefined && event.error !== null
            ? [event.error]
            : [event.message, `at ${event.filename}:${event.lineno}:${event.colno}`];
        ctx.emit('log', { level: 'error', source: 'uncaught', args: args.map((arg) => ctx.serialize(arg)) });
      };
      const onRejection = (event: PromiseRejectionEvent) => {
        ctx.emit('log', { level: 'error', source: 'unhandledrejection', args: [ctx.serialize(event.reason)] });
      };
      window.addEventListener('error', onError);
      window.addEventListener('unhandledrejection', onRejection);
      return () => {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
      };
    },
  };
}
