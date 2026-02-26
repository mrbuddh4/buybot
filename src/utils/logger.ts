import winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';

const logsDir = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const fileFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss',
  }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf((info) => {
    const base = `${info.timestamp} [${info.level}] ${info.message}`;
    const context = info.context ? ` | context=${info.context}` : '';
    const stack = info.stack ? `\n${info.stack}` : '';
    return `${base}${context}${stack}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fileFormat,
  defaultMeta: {
    service: 'telegram-buybot',
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
  exitOnError: false,
});

logger.add(
  new winston.transports.Console({
    format: consoleFormat,
  })
);
