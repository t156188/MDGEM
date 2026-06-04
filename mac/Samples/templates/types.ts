// TypeScript 模板

export interface User {
  id: number;
  name: string;
  email: string;
  role: "admin" | "editor" | "viewer";
  active?: boolean;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function findUser(users: User[], id: number): Result<User> {
  const user = users.find((u) => u.id === id);
  return user
    ? { ok: true, value: user }
    : { ok: false, error: `User ${id} not found` };
}

const users: User[] = [
  { id: 1, name: "Ada", email: "ada@example.com", role: "admin" },
  { id: 2, name: "Linus", email: "linus@example.com", role: "editor" },
];

const result = findUser(users, 1);
if (result.ok) {
  console.log(result.value.name);
} else {
  console.error(result.error);
}
