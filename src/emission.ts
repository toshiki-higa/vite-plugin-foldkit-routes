import type { Segment } from './discover.ts';

// Internal text-emission contract shared by the URL and tree emitters.
// These helpers only name declarations or assemble supplied schema/config text.
export const ownerIdentifier = (layout: boolean, index: number) => `${layout ? 'L' : 'P'}${index}`;

export const pageIdentifiers = (index: number) => ({
  owner: ownerIdentifier(false, index),
  params: `Params${index}`,
  search: `Search${index}`,
  payload: `Payload${index}`,
  codec: `Codec${index}`,
  router: `Router${index}`,
  acceptance: `Acceptance${index}`,
  equalParams: `equalParams${index}`,
  equalSearch: `equalSearch${index}`,
});

// Supply absent params before spreading precise configs, without widening codecs.
// Callers supply configs in inherited-to-local order; no discovery happens here.
export const inheritedParamsConfig = (configs: readonly string[]) =>
  `{params:{${configs.map((config) => `...({...{params:{}},...${config}}).params`).join(',')}}}`;

export const paramSchema = (config: string, name: string) =>
  `Runtime.paramSchema(${config},${JSON.stringify(name)})`;

export const paramFields = (segments: readonly Segment[], config: string) =>
  segments
    .filter((segment) => segment.kind !== 'static')
    .map((segment) => {
      const schema = paramSchema(config, segment.name);
      return `[${JSON.stringify(segment.name)}]:${segment.kind === 'rest' ? `Schema.NonEmptyArray(${schema})` : schema}`;
    })
    .join(',');
