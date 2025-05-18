FROM node:18-slim

# Install qpdf
RUN apt-get update && apt-get install -y qpdf

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Expose port and start the app
EXPOSE 10000
CMD ["node", "index.js"]
