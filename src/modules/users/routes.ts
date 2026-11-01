import { Router } from 'express';
import type { Ctx } from '../../context';
import { actorOf, authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler, idParam, ok, paginated } from '../../utils/http';
import type { UserService } from './service';
import { createUserBody, listUsersQuery, updateUserBody } from './schemas';

export function usersRouter(ctx: Ctx, users: UserService) {
  const r = Router();
  r.use(authenticate(ctx), requireRole('admin'));

  r.get('/', validate({ query: listUsersQuery }), asyncHandler((req, res) => {
    const q = req.valid!.query;
    const { items, total } = users.list(q);
    paginated(res, items, q.page, q.pageSize, total);
  }));
  r.post('/', validate({ body: createUserBody }), asyncHandler(async (req, res) =>
    ok(res, await users.create(req.body, actorOf(req)), 201)));
  r.get('/:id', validate({ params: idParam }), asyncHandler((req, res) => ok(res, users.getById(req.valid!.params.id))));
  r.patch('/:id', validate({ params: idParam, body: updateUserBody }), asyncHandler((req, res) =>
    ok(res, users.update(req.valid!.params.id, req.body, actorOf(req)))));
  return r;
}
