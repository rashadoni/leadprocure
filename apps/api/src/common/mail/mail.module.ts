import { Global, Injectable, Logger, Module } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { AppConfig } from '../config/config.service';

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Provider seam for outbound email. Console provider keeps the demo working with no SMTP
// (logs the message + any link); SMTP provider activates when SMTP_HOST is configured.
export abstract class MailProvider {
  abstract send(mail: Mail): Promise<void>;
  abstract readonly kind: string;
}

@Injectable()
export class ConsoleMailProvider extends MailProvider {
  readonly kind = 'console';
  private readonly logger = new Logger('Mail');
  async send(mail: Mail): Promise<void> {
    this.logger.log(`✉  to=${mail.to} · ${mail.subject}\n${mail.text ?? mail.html.replace(/<[^>]+>/g, ' ').trim()}`);
  }
}

@Injectable()
export class SmtpMailProvider extends MailProvider {
  readonly kind = 'smtp';
  private readonly transport: nodemailer.Transporter;
  private readonly from: string;
  constructor(cfg: AppConfig) {
    super();
    this.from = cfg.mailFrom;
    this.transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
    });
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MailProvider,
      useFactory: (cfg: AppConfig) => (cfg.smtpHost ? new SmtpMailProvider(cfg) : new ConsoleMailProvider()),
      inject: [AppConfig],
    },
  ],
  exports: [MailProvider],
})
export class MailModule {}
