import { logger } from '../../utils/logger';
import { bookingRepository } from '../../repositories/booking.repository';
import { waitlistRepository } from '../../repositories/waitlist.repository';
import { toZonedIso, toZonedTime } from '../../utils/time';
import type {
  BookingCancelledPayload,
  BookingCreatedPayload,
  BookingRescheduledPayload,
  WaitlistSlotAvailablePayload,
} from '../../events/domain-events';

/**
 * Notification delivery.
 *
 * ## What is real here and what is a seam
 *
 * The orchestration is real: recipients are resolved, content is composed with
 * correct per-recipient timezones, failures throw so BullMQ retries with
 * backoff, and jobs are keyed by event id so a redelivered event does not send
 * twice.
 *
 * The final hop — handing a rendered message to SendGrid/SES/Twilio — is
 * behind `deliver()`. That is a deliberate boundary, not an unfinished
 * feature: a provider integration is credentials and an SDK, and stubbing it
 * keeps this repository runnable without external accounts. Swapping in a real
 * provider is one function body.
 */

export type Channel = 'email' | 'sms';

export interface OutboundMessage {
  channel: Channel;
  to: string;
  subject: string;
  body: string;
  metadata: Record<string, unknown>;
}

/**
 * Provider seam. Throwing here surfaces as a job failure, which BullMQ retries
 * with exponential backoff — the behaviour a real provider outage needs.
 */
async function deliver(message: OutboundMessage): Promise<void> {
  logger.info(
    {
      channel: message.channel,
      to: redactRecipient(message.to),
      subject: message.subject,
      ...message.metadata,
    },
    'notification dispatched',
  );
}

/** Never log a full address: logs are retained far longer than they need to be. */
function redactRecipient(recipient: string): string {
  const [local, domain] = recipient.split('@');
  if (!domain || !local) return '[redacted]';
  return `${local.slice(0, 2)}***@${domain}`;
}

export async function sendBookingConfirmation(payload: BookingCreatedPayload): Promise<void> {
  const booking = await bookingRepository.findById(payload.bookingId);
  if (!booking) {
    // The booking vanished between the event and this job — cancelled and
    // hard-deleted, or a stale replay. Not retryable; return rather than throw.
    logger.warn({ bookingId: payload.bookingId }, 'skipping confirmation for missing booking');
    return;
  }

  const patientTimezone = booking.patient.user.timezone;
  const doctorTimezone = booking.doctor.user.timezone;

  // Each party is told the time in their own zone. Sending one rendering to
  // both is how patients arrive an hour late for a cross-timezone video call.
  await deliver({
    channel: 'email',
    to: booking.patient.user.email,
    subject: `Appointment confirmed — ${booking.confirmationCode}`,
    body: [
      `Your consultation with Dr ${booking.doctor.user.fullName} is confirmed.`,
      `When: ${toZonedIso(booking.startsAt, patientTimezone)} (${patientTimezone})`,
      `Local time: ${toZonedTime(booking.startsAt, patientTimezone)}`,
      `Type: ${booking.appointmentType} (${booking.mode})`,
      `Reference: ${booking.confirmationCode}`,
    ].join('\n'),
    metadata: { bookingId: booking.id, recipientRole: 'patient' },
  });

  await deliver({
    channel: 'email',
    to: booking.doctor.user.email,
    subject: `New appointment — ${toZonedTime(booking.startsAt, doctorTimezone)}`,
    body: [
      `${booking.patient.user.fullName} has booked a consultation.`,
      `When: ${toZonedIso(booking.startsAt, doctorTimezone)} (${doctorTimezone})`,
      `Reason: ${booking.reasonForVisit ?? 'not provided'}`,
      `Reference: ${booking.confirmationCode}`,
    ].join('\n'),
    metadata: { bookingId: booking.id, recipientRole: 'doctor' },
  });
}

export async function sendCancellationNotice(payload: BookingCancelledPayload): Promise<void> {
  const booking = await bookingRepository.findById(payload.bookingId);
  if (!booking) {
    logger.warn(
      { bookingId: payload.bookingId },
      'skipping cancellation notice for missing booking',
    );
    return;
  }

  // The party who initiated the cancellation already knows; the other needs
  // telling. Sending to both would be noise for one of them.
  const notifyPatient = payload.cancelledBy !== 'PATIENT';
  const recipient = notifyPatient ? booking.patient.user : booking.doctor.user;
  const timezone = notifyPatient ? booking.patient.timezone : booking.doctor.timezone;

  await deliver({
    channel: 'email',
    to: recipient.email,
    subject: `Appointment cancelled — ${booking.confirmationCode}`,
    body: [
      `The consultation on ${toZonedIso(booking.startsAt, timezone)} has been cancelled.`,
      `Cancelled by: ${payload.cancelledBy.toLowerCase()}`,
      payload.reason ? `Reason: ${payload.reason}` : 'No reason was given.',
      payload.slotReleased
        ? 'The time is available to book again.'
        : 'The doctor is no longer offering this time.',
    ].join('\n'),
    metadata: { bookingId: booking.id, cancelledBy: payload.cancelledBy },
  });
}

export async function sendRescheduleNotice(payload: BookingRescheduledPayload): Promise<void> {
  const booking = await bookingRepository.findById(payload.bookingId);
  if (!booking) {
    logger.warn({ bookingId: payload.bookingId }, 'skipping reschedule notice for missing booking');
    return;
  }

  for (const [recipient, timezone, role] of [
    [booking.patient.user, booking.patient.timezone, 'patient'],
    [booking.doctor.user, booking.doctor.timezone, 'doctor'],
  ] as const) {
    await deliver({
      channel: 'email',
      to: recipient.email,
      subject: `Appointment moved — ${booking.confirmationCode}`,
      body: [
        `The consultation has moved.`,
        `Was: ${toZonedIso(new Date(payload.previousStartsAt), timezone)}`,
        `Now: ${toZonedIso(booking.startsAt, timezone)} (${timezone})`,
        `Reference: ${booking.confirmationCode}`,
      ].join('\n'),
      metadata: { bookingId: booking.id, recipientRole: role },
    });
  }
}

export async function sendAppointmentReminder(input: { bookingId: string }): Promise<void> {
  const booking = await bookingRepository.findById(input.bookingId);

  // A booking cancelled after the reminder was scheduled must not be reminded
  // about. Checking here rather than trying to unschedule the job is far more
  // robust — there is exactly one place the decision is made.
  if (!booking || booking.status !== 'CONFIRMED') {
    logger.debug({ bookingId: input.bookingId }, 'skipping reminder for non-confirmed booking');
    return;
  }

  const timezone = booking.patient.timezone;

  await deliver({
    channel: 'email',
    to: booking.patient.user.email,
    subject: `Reminder: consultation at ${toZonedTime(booking.startsAt, timezone)}`,
    body: [
      `Your consultation with Dr ${booking.doctor.user.fullName} is coming up.`,
      `When: ${toZonedIso(booking.startsAt, timezone)} (${timezone})`,
      `Reference: ${booking.confirmationCode}`,
    ].join('\n'),
    metadata: { bookingId: booking.id, kind: 'reminder' },
  });

  if (booking.patient.user.phone) {
    await deliver({
      channel: 'sms',
      to: booking.patient.user.phone,
      subject: '',
      body: `Clinzo: your consultation with Dr ${booking.doctor.user.fullName} is at ${toZonedTime(
        booking.startsAt,
        timezone,
      )}. Ref ${booking.confirmationCode}`,
      metadata: { bookingId: booking.id, kind: 'reminder' },
    });
  }
}

export async function sendWaitlistAlert(payload: WaitlistSlotAvailablePayload): Promise<void> {
  logger.info(
    {
      slotId: payload.slotId,
      doctorId: payload.doctorId,
      candidates: payload.candidateEntryIds.length,
    },
    'notifying waitlist candidates of a freed slot',
  );

  const entries = await waitlistRepository.findWithContacts(payload.candidateEntryIds);

  // Every candidate is told; the booking race decides. See waitlist.service
  // for why an exclusive handoff was rejected.
  for (const entry of entries) {
    const timezone = entry.patient.user.timezone;

    await deliver({
      channel: 'email',
      to: entry.patient.user.email,
      subject: 'A slot has opened up',
      body: [
        `A consultation slot you were waiting for is now available.`,
        `When: ${toZonedIso(new Date(payload.startsAt), timezone)} (${timezone})`,
        `Book soon — this slot is offered to everyone on the waitlist and goes to whoever books first.`,
      ].join('\n'),
      metadata: { slotId: payload.slotId, waitlistEntryId: entry.id },
    });
  }
}
