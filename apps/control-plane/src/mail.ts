import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { CloudConfig } from './config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Email from FBRX Command: confirming an FBRX account's address and resetting its password. Sent over SMTP
 * (FBRX_SMTP_URL, any transactional email service). Without it nothing is sent: the messages are kept here instead
 * (the last few, for development and tests), and the log says email is not set up.
 */
export interface Mailer {
  readonly configured: boolean;
  send(m: MailMessage): Promise<void>;
  /** What was "sent" while email is not set up, newest last. */
  readonly kept: MailMessage[];
}

export function createMailer(cfg: CloudConfig['mail'], log: FastifyBaseLogger): Mailer {
  if (!cfg) {
    const kept: MailMessage[] = [];
    return {
      configured: false,
      kept,
      async send(m) {
        kept.push(m);
        if (kept.length > 50) kept.shift();
        log.warn({ subject: m.subject }, 'Email is not set up (FBRX_SMTP_URL): nothing was sent');
      },
    };
  }
  const transport = nodemailer.createTransport(cfg.url);
  return {
    configured: true,
    kept: [],
    async send(m) {
      await transport.sendMail({ from: cfg.from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
