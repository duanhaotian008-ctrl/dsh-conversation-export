import {
  ConversationExportService, createDownloadHandler, createExportTool,
  validateConfig, configSchema, EXPORT_PATH,
} from './host-service.js';

export const name = 'local-conversation-export';
export const inject = ['connection', 'sessionQuery'];

// Cordis 4 accepts synchronous Standard Schema validators. Keeping this small
// avoids a second schema library/runtime dependency in the linked bundle.
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'local-conversation-export',
    validate(value) {
      try { return { value: validateConfig(value) }; }
      catch (error) { return { issues: [{ message: error.message }] }; }
    },
    jsonSchema: {
      input: () => ({ ...configSchema, default: {} }),
      output: () => configSchema,
    },
  },
};

export function apply(ctx, config) {
  const service = new ConversationExportService(ctx.sessionQuery, config);
  ctx.effect(() => ctx.provide('conversationExport', service), 'conversation-export: service');
  ctx.effect(() => ctx.connection.fetch.register({
    path: EXPORT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: createDownloadHandler(service),
  }), 'conversation-export: authenticated download');
  // Absence of agent tools/spill storage must not prevent the sidebar download.
  ctx.inject(['tools', 'spillStore'], toolCtx => {
    toolCtx.effect(() => toolCtx.tools.register(createExportTool(service, toolCtx.spillStore)),
      'conversation-export: agent tool');
  });
  // Abort and drain owned reads on unload. Cordis may dispose sibling
  // effects concurrently, so route/service removal need not wait for draining.
  ctx.effect(() => () => service.dispose(), 'conversation-export: in-flight reads');
}
