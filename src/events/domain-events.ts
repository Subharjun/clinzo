/**
 * Domain event catalogue.
 *
 * These names are a published contract: they are persisted in `outbox_events`
 * and consumed by workers (and, in a later iteration, by other services over
 * Kafka). Renaming one is a breaking change; adding a field is not.
 *
 * Payloads carry ids plus the minimum denormalised context a consumer needs to
 * act without a synchronous call back into this service — that decoupling is
 * the entire point of publishing events rather than invoking handlers.
 */

export const EventType = {
  BOOKING_CREATED: 'booking.created',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_RESCHEDULED: 'booking.rescheduled',

  SLOT_RELEASED: 'slot.released',
  SLOT_BLOCKED: 'slot.blocked',

  HOLD_CREATED: 'hold.created',
  HOLD_EXPIRED: 'hold.expired',
  HOLD_RELEASED: 'hold.released',

  AVAILABILITY_CHANGED: 'availability.changed',

  WAITLIST_SLOT_AVAILABLE: 'waitlist.slot_available',
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

export const AggregateType = {
  BOOKING: 'Booking',
  SLOT: 'Slot',
  HOLD: 'ReservationHold',
  AVAILABILITY: 'Availability',
} as const;

export type AggregateTypeName = (typeof AggregateType)[keyof typeof AggregateType];

export interface BookingCreatedPayload {
  bookingId: string;
  slotId: string;
  patientId: string;
  doctorId: string;
  confirmationCode: string;
  /** ISO-8601 UTC. */
  startsAt: string;
  endsAt: string;
  appointmentType: string;
  mode: string;
}

export interface BookingCancelledPayload {
  bookingId: string;
  slotId: string;
  patientId: string;
  doctorId: string;
  startsAt: string;
  cancelledBy: string;
  reason: string | null;
  /** True when the freed slot returned to AVAILABLE (vs. stayed BLOCKED). */
  slotReleased: boolean;
}

export interface BookingRescheduledPayload {
  previousBookingId: string;
  bookingId: string;
  previousSlotId: string;
  slotId: string;
  patientId: string;
  doctorId: string;
  previousStartsAt: string;
  startsAt: string;
}

export interface SlotReleasedPayload {
  slotId: string;
  doctorId: string;
  startsAt: string;
  endsAt: string;
  appointmentType: string;
  /** What freed the slot: cancellation, hold expiry, or an admin action. */
  releasedBy: 'cancellation' | 'hold_expiry' | 'admin';
}

export interface SlotBlockedPayload {
  slotIds: string[];
  doctorId: string;
  availabilityId: string | null;
  reason: string;
}

export interface HoldPayload {
  holdId: string;
  slotId: string;
  patientId: string;
  doctorId: string;
  expiresAt: string;
}

export interface AvailabilityChangedPayload {
  availabilityId: string;
  doctorId: string;
  changeType: 'created' | 'updated' | 'deleted';
  slotsGenerated: number;
  slotsBlocked: number;
  /** Bookings that fall outside the new window and need human resolution. */
  orphanedBookingIds: string[];
}

export interface WaitlistSlotAvailablePayload {
  slotId: string;
  doctorId: string;
  startsAt: string;
  endsAt: string;
  candidateEntryIds: string[];
}

/** Discriminated union of everything the outbox can carry. */
export type DomainEvent =
  | { type: typeof EventType.BOOKING_CREATED; payload: BookingCreatedPayload }
  | { type: typeof EventType.BOOKING_CANCELLED; payload: BookingCancelledPayload }
  | { type: typeof EventType.BOOKING_RESCHEDULED; payload: BookingRescheduledPayload }
  | { type: typeof EventType.SLOT_RELEASED; payload: SlotReleasedPayload }
  | { type: typeof EventType.SLOT_BLOCKED; payload: SlotBlockedPayload }
  | { type: typeof EventType.HOLD_CREATED; payload: HoldPayload }
  | { type: typeof EventType.HOLD_EXPIRED; payload: HoldPayload }
  | { type: typeof EventType.HOLD_RELEASED; payload: HoldPayload }
  | { type: typeof EventType.AVAILABILITY_CHANGED; payload: AvailabilityChangedPayload }
  | { type: typeof EventType.WAITLIST_SLOT_AVAILABLE; payload: WaitlistSlotAvailablePayload };
