# Web UI dev server (Vite). Runs `vite` with hot reload; source is
# bind-mounted by docker-compose.yml rather than copied in, so edits on the
# host apply immediately without an image rebuild.
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

EXPOSE 5173

# --host binds 0.0.0.0 so the container's port is reachable from the host;
# Vite's dev server otherwise only binds localhost inside the container.
CMD ["npm", "run", "dev", "--", "--host"]
