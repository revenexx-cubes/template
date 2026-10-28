# Template Cube

Describe here, for whoever has to change the Cube or check its numbers:

- what it adds to the Analytics Studio, by catalog key (`<name>.<report>`, `<name>.<metric>`);
- where its data comes from — a file in the release, a function, a connection — and how
  often it changes;
- how a dataset joins app data (which dimension declares `joins`, and why a join cannot count
  a row twice);
- how to check a value against a read-only `SELECT`.
