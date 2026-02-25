# AWS Innovation Sandbox - User Interface (UI)

This project provides a User Interface (UI) to support the AWS Innovation Sandbox solution.

This project is a React project bootstrapped with [Vite](https://vite.dev).

---

## Getting started

1. Ensure that the [AWS Innovation Sandbox CDK](../cdk) project has been deployed to your AWS account.
2. Run `npm install` to install NPM packages
3. After the CDK stack is deployed, a post deployment script will automatically generate a config file (`config.js`) in the `public`. This allows the local UI server to connect to the deployed backend in AWS.
4. Run `npm start` to run the UI locally

---

## Project Structure

#### Key Libraries

1. [React](https://react.dev) - React v18 framework

2. [Cloudscape Design Components](https://cloudscape.design) - An open source design system for cloud applications.

3. [AWS Northstar](https://aws.github.io/aws-northstar) - A design library built on top of Cloudscape that provides a way to rapidly build tables, forms and other UI elements.

4. [AWS Amplify UI](https://ui.docs.amplify.aws) - The project uses Amplify UI to generate login/signup screens that integrate with [Amazon Cognito](https://aws.amazon.com/cognito). Note: the wider Amplify ecosystem including CLI and deployment mechanisms are **not** used in this project.

5. [React Query](https://tanstack.com/query/latest/docs/framework/react/overview) - for fetching, caching and synchronising data fetched from the back end API's.

#### Folder Structure

- `src/assets` - static assets such as images and stylesheets

- `src/domains` - each domain is split into its own sub folders with the following structure:
  - `pages` - a folder for pages specific to that domain
  - `components` - a folder for components specific to that domain
  - `service.ts` - a class that performs business logic for that domain, e.g. fetching data from an API
  - `hooks.ts` - a set of React hooks that wrap the above services using React Query
  - `types.ts` - any type definitions specific to that domain

- `src/components` - any common/shared components that are not domain specific go in this folder

- `src/helpers` - any helper or utility functions go in this folder. Ideally these should be unit testable and not include React/JSX.

---

## Available Scripts

In the project directory, you can run:

#### Local development

```
npm start
```

The page will reload when you make changes.\
You may also see any lint errors in the console.

#### Build for deployment

```
npm run build
```

Builds the app for production to the `dist` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include hashes.
