// FWE extension setup is synchronous; ESM application code is loaded by handlers.
module.exports = (fwe) => {
  fwe.registerSource('fwa-projection', {
    list: () => [{ name: 'projection.json', label: 'Project projection', exists: true }],
    async read(ctx, name) {
      if (name !== 'projection.json') throw Object.assign(new Error('Unknown projection resource.'), { status: 404 });
      const { FwaApplication } = await import('../../application/fwa-application.js');
      const data = await new FwaApplication(ctx.workspaceDir).getStatus();
      if (data.projectId !== ctx.source.expectedProjectId) throw Object.assign(new Error('Project identity changed; restart the console.'), { status: 409 });
      return { type: 'json', data };
    }
    // Intentionally no generic write/create/delete handlers.
  });
  fwe.registerApi('/api/fwa', async (context) => {
    const { handleConsoleApi } = await import('../console-api.js');
    return handleConsoleApi(context);
  });
};
