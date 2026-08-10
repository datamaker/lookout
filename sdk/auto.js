/**
 * Zero-code AWS Lambda auto-instrumentation.
 *
 * Preload via environment variables — no handler code changes needed:
 *   NODE_OPTIONS: -r @datasee/lookout/auto
 *   LOOKOUT_DSN:  https://<public-key>@lookout.example.com/<projectId>
 *
 * How it works: this file runs before the Lambda runtime loads the handler
 * module referenced by _HANDLER. It requires that module first, wraps the
 * exported handler (report to lookout, flush, rethrow), and leaves the
 * wrapped version in the module cache for the runtime to pick up. Retry/DLQ
 * semantics are preserved because the original error is rethrown.
 *
 * Activation requires LOOKOUT_DSN; without it this module is a no-op, so it
 * is safe to set NODE_OPTIONS unconditionally. Setting the DSN is the opt-in
 * (per stage, via deploy env), which keeps pre-prod stages able to exercise
 * the wrapper before prod. Set LOOKOUT_DISABLED=1 to force off with the DSN
 * still present.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const lookout = require('./dist/cjs/index.js');

function log(msg) {
  console.warn(`[lookout/auto] ${msg}`);
}

function wrap(handler) {
  // Exactly two declared params: the Node.js 24+ runtime treats any handler
  // with a third (callback) param as callback-based and refuses to init
  // (Runtime.CallbackHandlerDeprecated), even if the function is async.
  return async function lookoutWrappedHandler(event, context) {
    try {
      return await handler(event, context);
    } catch (err) {
      try {
        lookout.captureException(err, {
          extra: {
            functionName: context && context.functionName,
            awsRequestId: context && context.awsRequestId,
            source: event && event.source,
            detailType: event && event['detail-type'],
          },
        });
        // Lambda freezes right after the error is returned; send before rethrowing.
        await lookout.flush(2000);
      } catch (reportErr) {
        log(`failed to report error: ${reportErr.message}`);
      }
      throw err;
    }
  };
}

function instrument() {
  const dsn = process.env.LOOKOUT_DSN;
  const handlerRef = process.env._HANDLER;
  if (!dsn || !handlerRef) return;
  if (process.env.LOOKOUT_DISABLED) return;

  // "_HANDLER" looks like "src/consumers/jobEventConsumer.handler":
  // everything after the last dot is the export name.
  const dot = handlerRef.lastIndexOf('.');
  if (dot === -1) {
    log(`unrecognized _HANDLER "${handlerRef}"; skipping`);
    return;
  }
  const modulePath = handlerRef.slice(0, dot);
  const exportName = handlerRef.slice(dot + 1);
  const taskRoot = process.env.LAMBDA_TASK_ROOT || process.cwd();
  const fullPath = path.join(taskRoot, modulePath);

  // ESM handlers (.mjs / "type": "module") can't be wrapped this way — bail out.
  if (fs.existsSync(`${fullPath}.mjs`)) {
    log('ESM handler detected; auto-instrumentation skipped');
    return;
  }

  let mod;
  try {
    mod = require(fullPath);
  } catch (err) {
    log(`could not preload handler module "${modulePath}": ${err.message}`);
    return;
  }
  if (typeof mod[exportName] !== 'function') {
    log(`export "${exportName}" of "${modulePath}" is not a function; skipping`);
    return;
  }

  lookout.init({
    dsn,
    environment: process.env.LOOKOUT_ENVIRONMENT || process.env.STAGE || process.env.NODE_ENV,
    // The Lambda runtime owns uncaught-error handling; don't install process hooks.
    captureUnhandled: false,
  });

  mod[exportName] = wrap(mod[exportName]);
}

try {
  instrument();
} catch (err) {
  log(`instrumentation failed: ${err.message}`);
}
