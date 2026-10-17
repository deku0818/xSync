import { z } from "zod";

export const OBJECT_CAPABILITY = "addressed-objects-v1";
export const objectIDPattern = /^(?:c_)?[a-f0-9]{64}$/;
export const objectIDSchema = z.string().regex(objectIDPattern);
export const isAddressedObject = (id: string): boolean => /^c_[a-f0-9]{64}$/.test(id);
