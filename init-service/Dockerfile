# Use the official Node.js image as a parent image
FROM node:20

# Set the working directory in the container
WORKDIR /code

# Copy package.json and package-lock.json (if available) to the working directory
COPY package*.json ./

# Install any dependencies
RUN npm install

# Copy the rest of your application's code to the working directory
COPY . .

# Build your app
RUN npm run build

# init-service listens on 3001 by default (see PORT in src/.env.example)
EXPOSE 3001

# Define the command to run your app using CMD which defines your runtime
CMD [ "node", "dist/index.js" ]
