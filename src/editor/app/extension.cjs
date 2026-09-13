// FWE extension setup is synchronous; ESM application code is loaded by handlers.
module.exports = (fwe) => {
  async function status(ctx) {
    const { FwaApplication } = await import('../../application/fwa-application.js');
    const data = await new FwaApplication(ctx.workspaceDir).getStatus();
    if (data.projectId !== ctx.source.expectedProjectId) throw Object.assign(new Error('Project identity changed; restart the console.'), { status: 409 });
    return data;
  }
  fwe.registerSource('fwa-projection', {
    async list(ctx) {
      const { listObjectResources } = await import('../object-resources.js');
      return listObjectResources(await status(ctx));
    },
    async read(ctx, name) {
      const { readObjectResource } = await import('../object-resources.js');
      return readObjectResource(await status(ctx), name);
    }
    // Intentionally no generic write/create/delete handlers.
  });
  fwe.registerApi('/api/fwa', async (context) => {
    const { handleConsoleApi } = await import('../console-api.js');
    return handleConsoleApi(context);
  });
};
