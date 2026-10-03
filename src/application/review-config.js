import { lstat, readFile } from 'node:fs/promises';
import { CommandEvaluator } from '../adapters/command-evaluator.js';
import { normalizeIntegrationTargetRef } from './integration-orchestrator.js';
import { hashCanonicalValue } from '../storage/file-event-store.js';
import { normalizeExperimentConfig } from './change-experiments.js';

const fail = message => Object.assign(new Error(message), { code: 'review-config-invalid' });

/** Trusted launch configuration; never accepted from an HTTP command. */
export function normalizeReviewConfig(value) {
  if (!value || value.schemaVersion !== 1 || Object.keys(value).some(key => ![
    'schemaVersion', 'targetRef', 'validationProfiles', 'regressionProfile', 'experiment', 'completionPolicy'
  ].includes(key)) || !Array.isArray(value.validationProfiles) || !value.validationProfiles.length) {
    throw fail('Review config requires schemaVersion: 1, targetRef, validationProfiles and regressionProfile.');
  }
  const evaluator = new CommandEvaluator();
  const validationProfiles = value.validationProfiles.map(profile => evaluator.normalizeProfile(profile));
  if (new Set(validationProfiles.map(profile => profile.id)).size !== validationProfiles.length) throw fail('Validation profile IDs must be unique.');
  let completionPolicy;
  if (value.completionPolicy !== undefined) {
    const policy = value.completionPolicy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || Object.keys(policy).some(key => !['mode', 'manualProfiles'].includes(key))
      || !['manual', 'automatic'].includes(policy.mode) || !Array.isArray(policy.manualProfiles)
      || policy.manualProfiles.some(id => typeof id !== 'string' || !validationProfiles.some(profile => profile.id === id))
      || new Set(policy.manualProfiles).size !== policy.manualProfiles.length) {
      throw fail('Completion policy requires manual or automatic mode and unique existing validation profile IDs in manualProfiles.');
    }
    completionPolicy = { mode: policy.mode, manualProfiles: [...policy.manualProfiles].sort() };
  }
  const regressionProfile = evaluator.normalizeProfile(value.regressionProfile);
  if (!['compile', 'test'].every(kind => regressionProfile.checks.some(check => check.kind === kind))) {
    throw fail('Regression profile must contain actual compile and test checks.');
  }
  const config = { schemaVersion: 1, targetRef: normalizeIntegrationTargetRef(value.targetRef),
    validationProfiles, regressionProfile, ...(value.experiment === undefined ? {} : { experiment: normalizeExperimentConfig(value.experiment) }),
    ...(completionPolicy === undefined ? {} : { completionPolicy }) };
  return { ...config, fingerprint: hashCanonicalValue(config) };
}

export async function loadReviewConfig(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw fail('Review config must be a regular JSON file of at most 256 KiB.');
  return normalizeReviewConfig(JSON.parse(await readFile(file, 'utf8')));
}
