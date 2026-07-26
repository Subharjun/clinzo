import { z } from 'zod';
import { emailSchema, passwordSchema, timezoneSchema } from './common.validator';

/** Request schemas for `/auth`. */

export const loginSchema = z.object({
  email: emailSchema,
  // Not `passwordSchema`: login must accept any string, including passwords
  // that predate a policy change. Applying registration rules here would lock
  // out legitimate users and leak the policy to an attacker.
  password: z.string().min(1, 'is required').max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'is required'),
});

export const logoutSchema = refreshSchema;

export const registerPatientSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().min(2).max(120).trim(),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{6,14}$/, 'must be a valid E.164 phone number')
    .optional(),
  timezone: timezoneSchema.optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be formatted YYYY-MM-DD')
    .refine((value) => new Date(value) < new Date(), 'must be in the past')
    .optional(),
  gender: z.string().max(32).optional(),
});

export const registerDoctorSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().min(2).max(120).trim(),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{6,14}$/, 'must be a valid E.164 phone number')
    .optional(),
  // Required rather than optional for doctors: every availability window is
  // interpreted in this zone, so a wrong default here mis-times real
  // appointments.
  timezone: timezoneSchema,
  specialization: z.string().min(2).max(120).trim(),
  registrationNo: z.string().min(3).max(64).trim(),
  bio: z.string().max(2000).optional(),
  consultationFeeCents: z.number().int().min(0).max(100_000_000).optional(),
  defaultSlotDurationMinutes: z.number().int().min(5).max(480).optional(),
  defaultBufferMinutes: z.number().int().min(0).max(240).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterPatientInput = z.infer<typeof registerPatientSchema>;
export type RegisterDoctorInput = z.infer<typeof registerDoctorSchema>;
