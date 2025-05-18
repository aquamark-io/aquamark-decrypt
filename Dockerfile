FROM node:18-slim

# Install qpdf
FROM node:18-slim

# Install qpdf and canvas dependencies
RUN apt-get update && apt-get install -y \
  qpdf \
  libcairo2-dev \
  libjpeg-dev \
  libpango1.0-dev \
  libgif-dev \
  librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 10000
CMD ["node", "index.js"]

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
