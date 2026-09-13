import { lstat, readFile } from 'node:fs/promises';
import { CommandEvaluator } from '../adapters/command-evaluator.js';
import { normalizeIntegrationTargetRef } from './integration-orchestrator.js';
import { hashCanonicalValue } from '../storage/file-event-store.js';
import { normalizeExperimentConfig } from './change-experiments.js';

const fail = message => Object.assign(new Error(message), { code: 'review-config-invalid' });

/** Trusted launch configuration; never accepted from an HTTP command. */
export function normalizeReviewConfig(value) {
  if (!value || value.schemaVersion !== 1 || Object.keys(value).some(key => ![
    'schemaVersion', 'targetRef', 'validationProfiles', 'regressionProfile', 'experiment'
  ].includes(key)) || !Array.isArray(value.validationProfiles) || !value.validationProfiles.length) {
    throw fail('Review config requires schemaVersion: 1, targetRef, validationProfiles and regressionProfile.');
  }
  const evaluator = new CommandEvaluator();
  const validationProfiles = value.validationProfiles.map(profile => evaluator.normalizeProfile(profile));
  if (new Set(validationProfiles.map(profile => profile.id)).size !== validationProfiles.length) throw fail('Validation profile IDs must be unique.');
  const regressionProfile = evaluator.normalizeProfile(value.regressionProfile);
  if (!['compile', 'test'].every(kind => regressionProfile.checks.some(check => check.kind === kind))) {
    throw fail('Regression profile must contain actual compile and test checks.');
  }
  const config = { schemaVersion: 1, targetRef: normalizeIntegrationTargetRef(value.targetRef),
    validationProfiles, regressionProfile, ...(value.experiment === undefined ? {} : { experiment: normalizeExperimentConfig(value.experiment) }) };
  return { ...config, fingerprint: hashCanonicalValue(config) };
}

export async function loadReviewConfig(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw fail('Review config must be a regular JSON file of at most 256 KiB.');
  return normalizeReviewConfig(JSON.parse(await readFile(file, 'utf8')));
}
