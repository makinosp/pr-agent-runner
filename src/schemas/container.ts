import { z } from 'zod';

/** Container object keys that map to an array of findings. */
export const CONTAINER_KEYS = ['comments', 'findings', 'issues', 'results'] as const;

export type ContainerKey = (typeof CONTAINER_KEYS)[number];

/** Container schema that accepts arrays of unknown items (individual validation is done by parseItems). */
const unknownItemList = z.array(z.unknown());

export const findingsContainerSchema = z
  .object({
    comments: unknownItemList.optional(),
    findings: unknownItemList.optional(),
    issues: unknownItemList.optional(),
    results: unknownItemList.optional(),
  })
  .catchall(z.unknown());
