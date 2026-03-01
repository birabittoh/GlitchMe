# Build stage
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy build-required files and build
COPY vite.config.ts tsconfig.json index.html ./
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM nginx:stable-alpine

# Copy build result from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
