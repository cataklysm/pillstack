import type { AppNotification } from '@pillstack/contracts';

/**
 * How a notification reaches a human.
 *
 * The domain decides *what* to announce and *when* (domain/reminders), the
 * application layer parks it in the `notification` outbox, and a port like this
 * takes it from there. Adding native desktop notifications when PillStack is
 * packaged means registering another port — no domain or schema change.
 */
export interface NotificationDeliveryPort {
  readonly channel: string;
  /**
   * Present a notification. Returns true when it actually reached the user, so
   * the outbox only marks delivered what was really shown.
   */
  deliver(notification: AppNotification): Promise<boolean>;
}

/**
 * The default channel for the local web app: nothing is pushed from the
 * server. Notifications wait in the outbox until the running UI polls for
 * them, displays them, and confirms — which is also what keeps PillStack
 * working with the browser closed and no background process running.
 */
export class OutboxDeliveryPort implements NotificationDeliveryPort {
  readonly channel = 'outbox';

  async deliver(): Promise<boolean> {
    // Delivery is completed by the client calling back with the ids it showed.
    return false;
  }
}

/** Useful in tests and headless runs: records what would have been shown. */
export class RecordingDeliveryPort implements NotificationDeliveryPort {
  readonly channel = 'recording';
  readonly delivered: AppNotification[] = [];

  async deliver(notification: AppNotification): Promise<boolean> {
    this.delivered.push(notification);
    return true;
  }
}
