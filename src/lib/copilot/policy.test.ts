import { expect, it } from 'vitest';
import { normalizeQuestion, requiresHuman } from './policy';
it('only normalizes Unicode, case and spacing; it does not infer semantic equivalence', () => {
  expect(normalizeQuestion('  ＨＯＵＲＳ\n Today?  ')).toBe('hours today?');
  expect(normalizeQuestion('hours today')).not.toBe(
    normalizeQuestion('hours today?')
  );
});
it.each([
  'Can I negotiate a discount?',
  'Refund please',
  'I dispute that',
  'I am uncertain',
  'Not sure',
  'A human person please',
  'Quiero un reembolso',
  'Necesito una persona',
  'Pedir desconto e negociar',
  'Quero uma pessoa',
  '환불해 주세요',
  '상담원 연결',
])('vetoes auto-authorization: %s', (text) => {
  expect(requiresHuman(text)).toBe(true);
});
