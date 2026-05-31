type User = {
  id: number;
  name: string;
  roles: string[];
};

const users: User[] = [
  { id: 1, name: "Ada", roles: ["admin", "editor"] },
  { id: 2, name: "Linus", roles: ["viewer"] },
  { id: 3, name: "Grace", roles: ["editor"] },
  { id: 3, name: "Grace", roles: ["editor"] },
  { id: 3, name: "Grace", roles: ["editor"] },
  { id: 3, name: "Grace", roles: ["editor"] },
];

function usersWithRole(role: string): User[] {
  return users.filter((user) => user.roles.includes(role));
}

for (const user of usersWithRole("editor")) {
  console.log(`${user.name} can edit documents`);
}
