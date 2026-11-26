/**
 * PocketHealth brand tokens (from pockethealth.com, inspected 2026-11-26). Mirrors src/ui/public/brand.css.
 * The UI and PDFs label this as a case-study demo, not a real PocketHealth product.
 */
import path from 'node:path';
import type { ApplicationStatus } from '../shared/types';

export const BRAND = {
  name: 'PocketHealth',
  product: 'Lending Ops',
  tagline: 'Case study demo',
  logoPath: process.env.REPORT_LOGO_PATH ?? path.join(__dirname, '../ui/public/brand/pockethealth-logo.svg'),
  font: 'Inter',
  colors: {
    blue: '#0066FF',
    blueTint: '#EFF7FF',
    ink: '#0F172A',
    text: '#475569',
    muted: '#64748B',
    border: '#CBD5E1',
    divider: '#E2E8F0',
    surface: '#F8FAFC',
    white: '#FFFFFF',
  },
};

export const STATUS_COLORS: Record<ApplicationStatus, string> = {
  RECEIVED: '#94A3B8',
  VALIDATING: '#7C8BA1',
  AWAITING_DOCS: '#0EA5E9',
  ENRICHING: '#64748B',
  AWAITING_PROVIDER: '#D946EF',
  UNDERWRITING: '#475569',
  HUMAN_REVIEW: '#7C3AED',
  AWAITING_SIGNATURE: '#14B8A6',
  DISBURSING: '#334155',
  FUNDED: '#0066FF',
  DECLINED: '#DC4C4C',
  ESCALATED: '#F59E0B',
};
