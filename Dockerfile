# Use official Node.js image
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Compile TypeScript (if there's a build script, otherwise run ts-node directly)
# Assuming typical setup:
# RUN npm run build 

# Expose port (Cloud Run defaults to 8080)
EXPOSE 8080

# Command to run the app (Requires a server.ts entrypoint which we still need to make!)
CMD [ "npx", "ts-node", "server.ts" ]
