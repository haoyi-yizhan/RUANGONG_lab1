import { createHash, randomUUID } from 'node:crypto';
import { ensure, text } from './errors.mjs';
import { hashSecret, matchesSecret, publicUser, secretToken, validatePassword } from './security.mjs';

const sessionDigest = token => createHash('sha256').update(token).digest('hex');

export const authMethods = {
  register({ phone, password, role }) {
    ensure(typeof phone === 'string' && /^1\d{10}$/u.test(phone),
      'INVALID_PHONE', '请输入 11 位大陆手机号');
    ensure(['participant', 'organizer'].includes(role), 'INVALID_ROLE', '仅可注册参与者或组织者');
    validatePassword(password);
    const recoveryCode = secretToken();
    const passwordHash = hashSecret(password);
    const recoveryHash = hashSecret(recoveryCode);
    const id = randomUUID();
    return this.atomic(() => {
      ensure(!this.db.prepare('SELECT id FROM users WHERE phone=?').get(phone),
        'DUPLICATE_PHONE', '手机号已注册', 409);
      this.db.prepare(`INSERT INTO users
        (id,phone,password_hash,recovery_hash,role,created_at) VALUES (?,?,?,?,?,?)`)
        .run(id, phone, passwordHash, recoveryHash, role, this.now());
      this.audit(id, 'register', 'user', id, '', role);
      return { user: publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id)), recoveryCode };
    });
  },

  login({ phone, password }) {
    ensure(typeof phone === 'string', 'INVALID_PHONE', '请输入手机号');
    const user = this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
    ensure(user && matchesSecret(password, user.password_hash),
      'INVALID_CREDENTIALS', '手机号或密码错误', 401);
    ensure(!user.banned, 'ACCOUNT_BANNED', '账号已被封禁', 403);
    const token = secretToken();
    this.atomic(() => {
      this.db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
        .run(sessionDigest(token), user.id, this.now() + 8 * 60 * 60 * 1000);
      this.audit(user.id, 'login', 'user', user.id);
    });
    return { user: publicUser(user), token };
  },

  authenticate(token) {
    if (!token || typeof token !== 'string' || token.length > 256) {
      return null;
    }
    const session = this.db.prepare(`SELECT user_id FROM auth_sessions
      WHERE token_hash=? AND expires_at>?`).get(sessionDigest(token), this.now());
    if (!session) {
      return null;
    }
    return publicUser(this.actor(session.user_id));
  },

  logout(token) {
    if (token) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(sessionDigest(token));
    }
    return { loggedOut: true };
  },

  verify(actorId, { name, idNumber }) {
    const user = this.actor(actorId, ['participant', 'organizer']);
    const validName = text(name, '真实姓名', 50);
    ensure(typeof idNumber === 'string' && /^\d{17}[\dX]$/u.test(idNumber),
      'INVALID_IDENTITY', '身份证号应为 18 位，末位 X 须大写');
    // This is a local simulated identity binding, not a government identity lookup.
    ensure(!user.id_number, 'ALREADY_VERIFIED', '已绑定实名信息，不可自行更换');
    return this.atomic(() => {
      ensure(!this.db.prepare('SELECT id FROM users WHERE id_number=?').get(idNumber),
        'DUPLICATE_IDENTITY', '该身份证号已绑定其他账号', 409);
      this.db.prepare('UPDATE users SET name=?,id_number=? WHERE id=?')
        .run(validName, idNumber, user.id);
      this.audit(user.id, 'verify_identity', 'user', user.id, 'unverified', 'verified');
      return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(user.id));
    });
  },

  resetPassword({ phone, recoveryCode, password }) {
    validatePassword(password);
    const user = this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone || '');
    ensure(user && matchesSecret(recoveryCode, user.recovery_hash),
      'INVALID_RECOVERY', '手机号或恢复码错误', 401);
    const newRecoveryCode = secretToken();
    this.atomic(() => {
      this.db.prepare('UPDATE users SET password_hash=?,recovery_hash=? WHERE id=?')
        .run(hashSecret(password), hashSecret(newRecoveryCode), user.id);
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);
      this.audit(user.id, 'reset_password', 'user', user.id, '', 'credentials_rotated');
    });
    return { recoveryCode: newRecoveryCode };
  },

  listUsers(actorId) {
    this.actor(actorId, ['admin']);
    return this.db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(publicUser);
  },

  setBanned(actorId, userId, { banned, reason }) {
    const actor = this.actor(actorId, ['admin']);
    ensure(typeof banned === 'boolean', 'INVALID_INPUT', '封禁状态必须是布尔值');
    ensure(actor.id !== userId, 'SELF_BAN', '不可封禁当前管理员');
    const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    ensure(user, 'NOT_FOUND', '账号不存在', 404);
    const explanation = text(reason, '操作原因', 500);
    return this.atomic(() => {
      this.db.prepare('UPDATE users SET banned=? WHERE id=?').run(Number(banned), userId);
      if (banned) {
        this.db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(userId);
      }
      this.audit(actor.id, banned ? 'ban_user' : 'unban_user', 'user', userId,
        Boolean(user.banned), { banned, reason: explanation });
      return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(userId));
    });
  },
};
