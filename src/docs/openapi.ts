/**
 * OpenAPI 3.0 description of the public API.
 *
 * Hand-authored rather than generated from the Zod schemas. Generation keeps
 * the shapes in sync automatically, but produces documentation that describes
 * *types* and not *behaviour* — and for this API the behaviour is the
 * interesting part. The 409 on `POST /bookings` and what a client should do
 * about it cannot be inferred from a schema.
 */

const errorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'SLOT_UNAVAILABLE' },
        message: { type: 'string' },
        details: { type: 'object', nullable: true },
        requestId: { type: 'string', format: 'uuid' },
      },
    },
  },
} as const;

const errorFor = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorResponse } },
});

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Clinzo Scheduling API',
    version: '1.0.0',
    description: `
Doctor slot scheduling for online consultations.

## Time handling

Every instant on the wire is ISO-8601 **UTC**. Responses additionally carry a
\`local\` block rendered in the viewer's timezone and, where relevant, the
counterparty's. Clients should display \`local\` and send back the UTC
\`startsAt\`/slot id — never re-derive a time from the local rendering.

## Booking concurrency

\`POST /bookings\` is safe under concurrent access. If two patients book the
same slot simultaneously, exactly one receives **201** and the other receives
**409** with code \`SLOT_UNAVAILABLE\`. This is enforced by a database
uniqueness constraint, so it holds regardless of load or replica count.

A 409 means the slot is genuinely gone: **do not retry the same slot**. Refresh
the slot listing and offer the patient an alternative.

## Idempotency

\`POST /bookings\` and \`PUT /bookings/{id}/reschedule\` accept an
\`Idempotency-Key\` header. Retrying with the same key and body replays the
original response instead of re-executing, which makes booking safe over an
unreliable network. Reusing a key with a *different* body returns 409
\`IDEMPOTENCY_CONFLICT\`.

## Reservation holds

For flows with a payment step, \`POST /holds\` reserves a slot for a short TTL
(default 120s). Complete the booking with \`POST /bookings\` passing \`holdId\`.
If payment fails or the patient abandons checkout, the hold expires by itself
and the slot returns to sale — no client action required.
`.trim(),
    contact: { name: 'Clinzo Engineering' },
    license: { name: 'MIT' },
  },
  servers: [{ url: '/api/v1', description: 'Current version' }],
  tags: [
    { name: 'Auth', description: 'Registration, login and token lifecycle' },
    { name: 'Doctors', description: 'Directory and profiles' },
    { name: 'Slots', description: 'Bookable slot discovery' },
    { name: 'Availability', description: 'Doctor-managed working windows' },
    { name: 'Bookings', description: 'Booking, cancellation and rescheduling' },
    { name: 'Holds', description: 'Short-lived checkout reservations' },
    { name: 'Waitlist', description: 'Notification when a slot frees up' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string', minLength: 8, maxLength: 255 },
        description:
          'Client-generated unique key. Retrying with the same key and body replays the original response.',
      },
    },
    schemas: {
      Error: errorResponse,
      TokenPair: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          expiresIn: { type: 'integer', example: 900, description: 'Access token lifetime (s)' },
          tokenType: { type: 'string', example: 'Bearer' },
        },
      },
      Slot: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          startsAt: { type: 'string', format: 'date-time', description: 'UTC' },
          endsAt: { type: 'string', format: 'date-time', description: 'UTC' },
          durationMinutes: { type: 'integer', example: 15 },
          appointmentType: { type: 'string', example: 'STANDARD' },
          mode: { type: 'string', enum: ['VIDEO', 'IN_CLINIC'] },
          local: {
            type: 'object',
            description: "Rendered in the viewer's timezone.",
            properties: {
              timezone: { type: 'string', example: 'Asia/Kolkata' },
              date: { type: 'string', example: '2026-03-02' },
              startTime: { type: 'string', example: '10:00' },
              endTime: { type: 'string', example: '10:15' },
              startsAt: { type: 'string', format: 'date-time' },
            },
          },
          doctorLocal: {
            type: 'object',
            description: "Rendered in the doctor's timezone.",
            properties: {
              timezone: { type: 'string' },
              date: { type: 'string' },
              startTime: { type: 'string' },
            },
          },
        },
      },
      Booking: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          confirmationCode: { type: 'string', example: 'CLZ-7Q4M2X' },
          status: {
            type: 'string',
            enum: ['CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'COMPLETED', 'NO_SHOW'],
          },
          slotId: { type: 'string', format: 'uuid' },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          mode: { type: 'string', enum: ['VIDEO', 'IN_CLINIC'] },
          appointmentType: { type: 'string' },
          reasonForVisit: { type: 'string', nullable: true },
          rescheduledFromId: { type: 'string', format: 'uuid', nullable: true },
          cancelledAt: { type: 'string', format: 'date-time', nullable: true },
          cancelledBy: {
            type: 'string',
            enum: ['PATIENT', 'DOCTOR', 'ADMIN', 'SYSTEM'],
            nullable: true,
          },
        },
      },
      Availability: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['ONE_OFF', 'RECURRING'] },
          date: { type: 'string', nullable: true, example: '2026-03-02' },
          weekday: {
            type: 'integer',
            nullable: true,
            minimum: 1,
            maximum: 7,
            description: '1 = Monday … 7 = Sunday',
          },
          startTime: { type: 'string', example: '10:00' },
          endTime: { type: 'string', example: '18:00' },
          timezone: { type: 'string', example: 'Asia/Kolkata' },
          slotDurationMinutes: { type: 'integer', example: 15 },
          bufferMinutes: { type: 'integer', example: 5 },
          version: {
            type: 'integer',
            description: 'Optimistic-locking guard; echo this back on update.',
          },
          isActive: { type: 'boolean' },
        },
      },
    },
  },
  paths: {
    '/auth/register/patient': {
      post: {
        tags: ['Auth'],
        summary: 'Register a patient account',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'fullName'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 12 },
                  fullName: { type: 'string' },
                  phone: { type: 'string', example: '+919876543210' },
                  timezone: { type: 'string', example: 'Asia/Kolkata' },
                  dateOfBirth: { type: 'string', example: '1990-05-14' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Account created; tokens issued' },
          409: errorFor('Email already registered'),
          422: errorFor('Validation failed'),
          429: errorFor('Rate limit exceeded'),
        },
      },
    },
    '/auth/register/doctor': {
      post: {
        tags: ['Auth'],
        summary: 'Register a doctor account',
        description:
          'Timezone is required: every availability window is interpreted in it, so a wrong value mis-times real appointments.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'email',
                  'password',
                  'fullName',
                  'timezone',
                  'specialization',
                  'registrationNo',
                ],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 12 },
                  fullName: { type: 'string' },
                  timezone: { type: 'string', example: 'Asia/Kolkata' },
                  specialization: { type: 'string', example: 'Cardiology' },
                  registrationNo: { type: 'string' },
                  defaultSlotDurationMinutes: { type: 'integer', example: 15 },
                  defaultBufferMinutes: { type: 'integer', example: 5 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Account created; tokens issued' },
          409: errorFor('Email or registration number already in use'),
          422: errorFor('Validation failed'),
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange credentials for tokens',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Authenticated' },
          401: errorFor('Invalid credentials — identical for unknown accounts'),
          429: errorFor('Too many failed attempts'),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token',
        description:
          'Refresh tokens rotate on every use. Presenting an already-rotated token revokes the entire token family and returns 401 — the standard response to a suspected stolen token.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['refreshToken'],
                properties: { refreshToken: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'New token pair issued' },
          401: errorFor('Token invalid, expired, or reuse detected'),
        },
      },
    },
    '/doctors': {
      get: {
        tags: ['Doctors'],
        summary: 'List doctors',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          { name: 'specialization', in: 'query', schema: { type: 'string' } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'acceptingPatientsOnly', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { 200: { description: 'A page of doctors' } },
      },
    },
    '/doctors/{id}/slots': {
      get: {
        tags: ['Slots'],
        summary: 'List bookable slots for a doctor',
        description:
          'Returns only AVAILABLE slots. Slots held by another patient mid-checkout are omitted rather than shown as busy.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          {
            name: 'from',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
            description: 'Inclusive UTC lower bound',
          },
          {
            name: 'to',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'date-time' },
            description: 'Exclusive UTC upper bound; at most 92 days after `from`',
          },
          { name: 'appointmentType', in: 'query', schema: { type: 'string' } },
          { name: 'mode', in: 'query', schema: { type: 'string', enum: ['VIDEO', 'IN_CLINIC'] } },
          {
            name: 'timezone',
            in: 'query',
            schema: { type: 'string' },
            description: "IANA zone for the `local` rendering; defaults to the doctor's",
          },
        ],
        responses: {
          200: {
            description: 'Available slots',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        doctorId: { type: 'string' },
                        doctorTimezone: { type: 'string' },
                        viewerTimezone: { type: 'string' },
                        count: { type: 'integer' },
                        slots: { type: 'array', items: { $ref: '#/components/schemas/Slot' } },
                      },
                    },
                  },
                },
              },
            },
          },
          404: errorFor('Doctor not found'),
          422: errorFor('Invalid or excessive range'),
        },
      },
    },
    '/availability': {
      post: {
        tags: ['Availability'],
        summary: 'Declare a working window and materialise its slots',
        security: [{ bearerAuth: [] }],
        description:
          'Times are wall-clock in the given timezone. Slots are generated immediately for the configured horizon; the response reports how many, plus any dates skipped for a daylight-saving gap.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['kind', 'startTime', 'endTime'],
                properties: {
                  kind: { type: 'string', enum: ['ONE_OFF', 'RECURRING'] },
                  date: { type: 'string', example: '2026-03-02', description: 'ONE_OFF only' },
                  weekday: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 7,
                    description: 'RECURRING only',
                  },
                  startTime: { type: 'string', example: '10:00' },
                  endTime: { type: 'string', example: '18:00' },
                  timezone: { type: 'string', example: 'Asia/Kolkata' },
                  slotDurationMinutes: { type: 'integer', example: 15 },
                  bufferMinutes: { type: 'integer', example: 5 },
                  effectiveFrom: { type: 'string', description: 'RECURRING only' },
                  effectiveUntil: { type: 'string', description: 'RECURRING only' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Window created and slots generated' },
          403: errorFor('Not a doctor'),
          409: errorFor('Overlaps an existing window'),
          422: errorFor('Validation or generation-size rule violated'),
        },
      },
      get: {
        tags: ['Availability'],
        summary: "List the authenticated doctor's windows",
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Windows' } },
      },
    },
    '/availability/{id}': {
      put: {
        tags: ['Availability'],
        summary: 'Edit a window',
        security: [{ bearerAuth: [] }],
        description: `
Retroactive edits are handled conservatively:

- Future **unbooked** slots outside the new window become BLOCKED.
- Future **booked** slots are left intact and returned as \`orphanedBookings\`
  for the doctor to resolve by hand. Confirmed appointments are never
  cancelled automatically.
- Past slots are never touched.

\`version\` must match the current record or the edit is rejected with 409.
`.trim(),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['version'],
                properties: {
                  startTime: { type: 'string', example: '10:00' },
                  endTime: { type: 'string', example: '14:00' },
                  slotDurationMinutes: { type: 'integer' },
                  bufferMinutes: { type: 'integer' },
                  isActive: { type: 'boolean' },
                  version: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Window updated; reconciliation summary returned' },
          403: errorFor('Window belongs to another doctor'),
          409: errorFor('Stale version — reload and retry'),
        },
      },
      delete: {
        tags: ['Availability'],
        summary: 'Withdraw a window',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Withdrawn; orphaned bookings reported' } },
      },
    },
    '/holds': {
      post: {
        tags: ['Holds'],
        summary: 'Reserve a slot for checkout',
        security: [{ bearerAuth: [] }],
        description:
          'Takes the slot off sale for `ttlSeconds`. Expiry is enforced by a Redis TTL, so an abandoned checkout releases the slot with no client action and no server-side cron dependency.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['slotId'],
                properties: {
                  slotId: { type: 'string', format: 'uuid' },
                  checkoutReference: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Hold created' },
          409: errorFor('Slot already booked or held by another patient'),
          422: errorFor('Too many concurrent holds, or slot already started'),
        },
      },
    },
    '/bookings': {
      post: {
        tags: ['Bookings'],
        summary: 'Book a slot',
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        description: `
Concurrency-safe. Under simultaneous requests for one slot, exactly one
succeeds with 201; the rest receive 409 \`SLOT_UNAVAILABLE\`.

**A 409 is final for that slot** — the slot is gone. Refresh the listing and
offer an alternative rather than retrying.

Pass \`holdId\` to convert an existing reservation hold into a booking.
`.trim(),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['slotId'],
                properties: {
                  slotId: { type: 'string', format: 'uuid' },
                  reasonForVisit: { type: 'string' },
                  holdId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Booking confirmed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { $ref: '#/components/schemas/Booking' },
                  },
                },
              },
            },
          },
          404: errorFor('Slot not found'),
          409: errorFor('Slot taken, or patient already booked at this time'),
          422: errorFor('Slot already started, or lead-time rule violated'),
          429: errorFor('Rate limit exceeded'),
        },
      },
    },
    '/bookings/me': {
      get: {
        tags: ['Bookings'],
        summary: 'List your bookings',
        security: [{ bearerAuth: [] }],
        description:
          "Returns the caller's bookings — as patient or as doctor, depending on the role in the token.",
        parameters: [
          {
            name: 'window',
            in: 'query',
            schema: { type: 'string', enum: ['upcoming', 'past', 'all'], default: 'upcoming' },
          },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated, e.g. `CONFIRMED,CANCELLED`',
          },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { 200: { description: 'A page of bookings' } },
      },
    },
    '/bookings/{id}': {
      get: {
        tags: ['Bookings'],
        summary: 'Fetch one booking',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'The booking' },
          404: errorFor('Not found, or you are not a party to it'),
        },
      },
      delete: {
        tags: ['Bookings'],
        summary: 'Cancel a booking',
        security: [{ bearerAuth: [] }],
        description:
          'The slot returns to sale immediately — unless the doctor has since withdrawn that time, in which case it stays blocked.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { reason: { type: 'string' } } },
            },
          },
        },
        responses: {
          200: { description: 'Cancelled' },
          403: errorFor('Not permitted to cancel this booking'),
          409: errorFor('Already cancelled or rescheduled'),
        },
      },
    },
    '/bookings/{id}/reschedule': {
      put: {
        tags: ['Bookings'],
        summary: 'Move a booking to a different slot',
        security: [{ bearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        description:
          'Atomic: the original appointment is only released once the new one is confirmed, so a failure leaves the patient holding their original booking rather than nothing. The target slot must belong to the same doctor.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['targetSlotId'],
                properties: {
                  targetSlotId: { type: 'string', format: 'uuid' },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Rescheduled; a new booking is returned' },
          409: errorFor('Target slot taken during the attempt'),
          422: errorFor('Past appointment, or a different doctor'),
        },
      },
    },
    '/waitlist': {
      post: {
        tags: ['Waitlist'],
        summary: 'Be notified when a slot frees up',
        security: [{ bearerAuth: [] }],
        description:
          'Notification does not reserve the slot: every matching candidate is told and the ordinary booking race decides, so one unresponsive patient cannot block a freed slot.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['doctorId', 'windowStart', 'windowEnd'],
                properties: {
                  doctorId: { type: 'string', format: 'uuid' },
                  windowStart: { type: 'string', format: 'date-time' },
                  windowEnd: { type: 'string', format: 'date-time' },
                  appointmentType: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Added to the waitlist' },
          409: errorFor('Already waitlisted for an overlapping window'),
        },
      },
    },
    '/patients/me': {
      get: {
        tags: ['Doctors'],
        summary: 'Your patient profile',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Profile' } },
      },
    },
  },
} as const;
