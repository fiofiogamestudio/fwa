/** Queries only durable experiment jobs; browsers cannot supply commands or paths. */
export async function queryExperiments(experiments, searchParams) {
  const changeSetId = searchParams.get('changeSetId');
  if (!changeSetId || changeSetId.length > 256) throw Object.assign(new Error('Choose a change to compare.'), { code: 'experiment-invalid', status: 400 });
  let inspection;
  try { inspection = await experiments.inspect(changeSetId); }
  catch (error) {
    if (error.code !== 'experiment-change-unavailable') throw error;
    inspection = { available: false, reason: '采用当前有效变化后，可创建包含/排除它的对照实验。' };
  }
  const jobs = await experiments.list(changeSetId);
  const jobId = searchParams.get('jobId');
  const selected = jobId ? jobs.find(item => item.id === jobId) : jobs.at(-1) ?? null;
  if (jobId && !selected) throw Object.assign(new Error('Experiment does not belong to this change.'), { code: 'experiment-not-found', status: 404 });
  return { inspection, selected, history: jobs.slice(-20).reverse().map(job => ({ id: job.id, commandId: job.commandId,
    state: job.state, createdAt: job.createdAt, comparison: job.result?.comparison ?? null })) };
}
