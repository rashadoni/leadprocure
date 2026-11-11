import { BadRequestException } from '@nestjs/common';

// Какой отдел на самом деле получит заявка. Одно место на всех, потому что спрашивают об
// этом двое и по-разному: сама подача — чтобы записать, и предпросмотр мастера — чтобы
// сказать человеку, какой бюджет он сейчас заденет.
//
// Пока ответа было два, они разошлись ровно там, где человек ничего не выбирал. В форме
// отдел по умолчанию — «мой отдел» (пустое значение), и разворачивает его СЕРВЕР при
// создании: домашний отдел автора из `memberships`. Предпросмотр об этом не знал и уходил
// с `NULL`, а подбор бюджета при `NULL` оставляет только общеорганизационные планы — то
// есть мастер называл не тот план, на который заявка ляжет, и терял предупреждение о
// пороге, ради которого этот блок на экране и существует. Нашла это сессия, разбиравшая
// мастер, и нашла по кадру из записи, где заявку создают при зрителе.
export async function resolveDepartment(
  m: { query(sql: string, params?: unknown[]): Promise<any> },
  auth: { sub: string; org_id: string },
  departmentId: string | undefined | null,
): Promise<string | null> {
  if (departmentId) {
    // Чужой отдел невидим под RLS, поэтому отсутствие строки — это либо опечатка, либо
    // попытка заглянуть в соседнюю организацию; и то и другое 400.
    const found = await m.query(`SELECT id, is_active FROM departments WHERE id = $1`, [departmentId]);
    if (!found.length) throw new BadRequestException('Unknown department');
    if (!found[0].is_active) throw new BadRequestException('Department is inactive');
    return departmentId;
  }
  const home = await m.query(
    `SELECT department_id FROM memberships WHERE user_id = $1 AND org_id = $2 AND department_id IS NOT NULL LIMIT 1`,
    [auth.sub, auth.org_id],
  );
  return home[0]?.department_id ?? null;
}
