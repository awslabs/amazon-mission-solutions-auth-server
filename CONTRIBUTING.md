# Contributing to OSML Auth Server

We welcome contributions to the OSML Auth Server project! This document provides guidelines and instructions for contributing.

## Code of Conduct

This project adheres to the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How to Contribute

### Reporting Issues

- Ensure the bug was not already reported by searching on GitHub under [Issues](https://github.com/your-organization/osml-auth-server/issues)
- If you're unable to find an open issue addressing the problem, [open a new one](https://github.com/your-organization/osml-auth-server/issues/new)
- Include a title and clear description, as much relevant information as possible, and a code sample or executable test case demonstrating the expected behavior that is not occurring

### Submitting Changes

1. Fork the repository
2. Create a new branch (`git checkout -b feature/your-feature-name`)
3. Make your changes
4. Run tests to ensure your changes don't break existing functionality
5. Commit your changes (`git commit -am 'Add some feature'`)
6. Push to the branch (`git push origin feature/your-feature-name`)
7. Create a new Pull Request

### Pull Request Process

1. Update the README.md or other documentation with details of changes, if applicable
2. Update the version numbers in any examples files and the README.md to the new version that this Pull Request would represent
3. The PR must pass all CI/CD checks before it will be merged
4. A maintainer will review your PR and provide feedback or approve it for merging

## Development Environment

### Prerequisites

- Node.js (v18 or higher)
- AWS CDK v2
- AWS CLI configured with appropriate permissions

### Setup

1. Clone the repository
2. Install dependencies:
```
cd cdk
npm install
```

### Testing

Run tests with:
```
cd cdk
npm test
```

### Linting

Run linting checks with:
```
cd cdk
npm run lint
```

Format code with:
```
cd cdk
npm run format
```

## Coding Guidelines

- Follow the TypeScript coding style used in the project
- Write meaningful commit messages
- Include comments and documentation for new code
- Write tests for new functionality
- Use the pre-commit hooks to ensure code quality

## License

By contributing to this project, you agree that your contributions will be licensed under the project's [Apache License 2.0](LICENSE).
