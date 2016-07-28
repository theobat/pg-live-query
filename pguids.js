const parser = require('pg-query-parser');

// Static indexes that track which tables have the meta objects
let indexes = {};

class PGUIDs {
	constructor(client, uid_col, rev_col, schema) {
		this.client   = client;
		this.uid_col  = uid_col || '__id__';
		this.rev_col  = rev_col || '__rev__';
		this.rev_seq  = `${this.rev_col}_sequence`;
		this.rev_func = `${this.rev_col}_update`;
		this.rev_trig = `${this.rev_col}_trigger`;
		this.schema   = schema || 'public';

		this.output = {
			uid : `${this.uid_col}'`,
			rev : `${this.rev_col}'`,
			seq : this.rev_seq
		};

		// Get all the existing uid/rev columns
		let col_sql = `
			SELECT
				n.nspname AS schema,
				c.relname AS table
			FROM
				pg_attribute a JOIN
				pg_class c ON
					c.oid = a.attrelid JOIN
				pg_namespace n ON
					n.oid = c.relnamespace
			WHERE
				a.attnum > 0 AND
				c.relkind = 'r' AND
				a.attname = $1 AND
				NOT a.attisdropped
			;
		`;

		// Get all the existing triggers
		let trigger_sql = `
			SELECT
				c.relname AS table,
				n.nspname AS schema
			FROM
				pg_trigger t JOIN
				pg_class c ON
					c.oid = t.tgrelid JOIN
				pg_namespace n ON
					n.oid = c.relnamespace
			WHERE
				t.tgname = $1
		`;

		let seq_sql = `
			CREATE SEQUENCE IF NOT EXISTS
				${this.quote(this.rev_seq)}
			START WITH 1
			INCREMENT BY 1
		`;

		let func_sql = `
			CREATE OR REPLACE FUNCTION ${this.quote(this.rev_func)}()
			RETURNS trigger AS $$
				BEGIN
					NEW.${this.quote(this.rev_col)} :=
						nextval('${this.quote(this.rev_seq)}');
					RETURN NEW;
				END;
			$$ LANGUAGE plpgsql
		`;

		this.init = new Promise((resolve, reject) => {
			// Find which tables have the uid/rev columns already
			let promises = [ this.uid_col, this.rev_col ].map((col) => {
				return new Promise((resolve, reject) => {
					client.query(col_sql, [ col ], (error, result) => {
						if(error) {
							reject(error);
						}
						else {
							// Build an index of fully-qualified table names
							let index = {};

							result.rows.forEach(({ schema, table }) => {
								index[JSON.stringify([ schema, table ])] = Promise.resolve(false);
							});

							resolve(index);
						}
					});
				});
			});

			// Build the rev trigger index
			promises.push(new Promise((resolve, reject) => {
				client.query(trigger_sql, [ this.rev_trig ], (error, result) => {
					if(error) {
						reject(error);
					}
					else {
						// Build an index of fully-qualified table names
						let index = {};

						result.rows.forEach(({ schema, table }) => {
							index[JSON.stringify([ schema, table ])] = Promise.resolve(false);
						});

						resolve(index);
					}
				});
			}));

			// Create the rev sequence
			promises.push(new Promise((resolve, reject) => {
				client.query(seq_sql, (error, result) => {
					error ? reject(error) : resolve();
				});
			}));

			// Create the rev function
			promises.push(new Promise((resolve, reject) => {
				client.query(func_sql, (error, result) => {
					error ? reject(error) : resolve();
				});
			}));

			// Wait for all the promises
			Promise.all(promises).then((results) => {
				[ this.uid_col, this.rev_col, this.rev_trig ].forEach((type, i) => {
					if(!indexes[type]) {
						indexes[type] = {};
					}

					Object.assign(indexes[type], results[i]);
				});

				resolve(indexes);
			}, reject);
		});
	}

	// Add meta columns to a query
	addMetaColumns(sql) {
		let parsed = parser.parse(sql);
		let tree   = parsed.query;

		if(!tree.length) {
			return Promise.reject(parsed.error);
		}

		// Ensure that the necessary database objects have been created
		return this.ensureObjects(tree).then(() => {
			// Add the uid and rev columns to the parse tree
			this._addMetaColumns(tree);

			// Deparse the parse tree back into a query
			return {
				sql    : parser.deparse(tree),
				tables : this.getTables(tree)
			};
		});
	}

	// Add meta columns to a parse tree
	_addMetaColumns(tree) {
		for(let i in tree) {
			let node = tree[i];

			// If this is not an object, we are not interested in it
			if(typeof node !== 'object') {
				continue;
			}

			// Add some columns to select statements
			if(node && node.SelectStmt) {
				let select = node.SelectStmt;

				if(select.fromClause) {
					// Check if the columns need to be aggregated
					let grouped = !!select.groupClause;

					// Get all the top-level tables in this select statement
					let tables = this.getTables(select.fromClause, true, true);

					// Create a node to select the aggregate revision
					let rev_node = compositeRevNode(
						tables,
						grouped,
						this.rev_col,
						this.output.rev
					);

					// Create a node to select the aggregate UID
					let uid_node = compositeUidNode(
						tables,
						grouped,
						this.uid_col,
						this.output.uid
					);

					select.targetList.unshift(rev_node);
					select.targetList.unshift(uid_node);
				}
			}

			// Check the child nodes
			this._addMetaColumns(node);
		}
	}

	// Create a column if it doesn't exist
	ensureCol(table, col, key) {
		let default_str = '';
		let type        = col === this.uid_col ? 'BIGSERIAL' : 'BIGINT';

		if(col === this.rev_col) {
			default_str = `
				DEFAULT nextval('${this.quote(this.rev_seq)}')
			`;
		}

		let alter_sql = `
			ALTER TABLE
				${this.quote(table.schema)}.${this.quote(table.table)}
			ADD COLUMN
				${this.quote(col)} ${type} ${default_str}
		`;

		// Make sure the initial objects have been created
		return this.init.then((indexes) => {
			let index = indexes[col] || {};

			if(!index[key]) {
				index[key] = new Promise((resolve, reject) => {
					this.client.query(alter_sql, (error, result) => {
						error ? reject(error) : resolve(true);
					});
				});
			}

			return index[key].then((created) => {
				return {
					table   : table,
					column  : col,
					created : created
				};
			});
		});
	}

	// Make sure there is a trigger for this table
	ensureTrigger(table, key) {
		let trigger_sql = `
			CREATE TRIGGER
				${this.quote(this.rev_trig)}
			BEFORE INSERT OR UPDATE ON
				${this.quote(table.schema)}.${this.quote(table.table)}
			FOR EACH ROW EXECUTE PROCEDURE ${this.quote(this.rev_func)}();
		`;

		// Make sure the initial objects have been created
		return this.init.then((indexes) => {
			let index = indexes[this.rev_trig];

			if(!index[key]) {
				index[key] = new Promise((resolve, reject) => {
					this.client.query(trigger_sql, (error, result) => {
						error ? reject(error) : resolve(true);
					});
				});
			}

			return index[key].then((created) => {
				return {
					table   : table,
					created : created
				};
			});
		});
	}

	// Ensure that all the referenced tables have uid/rev columns/triggers
	ensureObjects(tree) {
		let tables = this.getTables(tree);

		// Create the uid/rev columns
		let cols = [ this.uid_col, this.rev_col ].map((col) => {
			let cols = [];

			for(let key in tables) {
				cols.push(this.ensureCol(tables[key], col, key));
			}

			return cols;
		}).reduce((p, c) => p.concat(c));

		// Create the rev triggers
		let triggers = [];

		for(let key in tables) {
			triggers.push(this.ensureTrigger(tables[key], key));
		}

		return Promise.all(cols).then((columns) => {
			return Promise.all(triggers).then((triggers) => {
				return { columns, triggers };
			});
		});
	}

	// Get all the referenced tables from a parse tree
	getTables(tree, top_level, subselects) {
		let tables = {};

		for(let i in tree) {
			// If this node is not an object, we don't care about it
			if(typeof tree[i] !== 'object') {
				continue;
			}

			// If we're only getting top-level tables, ignore subqueries
			if(top_level && i === 'SelectStmt') {
				continue;
			}

			// If we're including tables from subselects and this is a subselect node
			if(subselects && i === 'RangeSubselect') {
				let table    = null;
				let schema   = null;
				let alias    = tree[i].alias.Alias.aliasname;
				let key      = JSON.stringify([ -1, alias ]);

				tables[key] = { table, schema, alias };
			}

			// If this is a table node
			if(i === 'RangeVar') {
				let table  = tree[i].relname;
				let schema = tree[i].schemaname || this.schema;
				let alias  = null;
				let key    = JSON.stringify([ schema, table ]);

				if(tree[i].alias) {
					alias = tree[i].alias.Alias.aliasname;
				}

				tables[key] = { table, schema, alias };
			}
			else {
				Object.assign(tables, this.getTables(tree[i], top_level, subselects));
			}
		}

		return tables;
	}

	// Quote an Identifier/Literal
	quote(id, literal) {
		if(literal) {
			return id.replace(/'/g, "''");
		}

		return `"${id.replace(/"/g, '""')}"`;
	}
}

// Helper function to generate a composite uid node
function compositeUidNode(tables, grouped, uid_col, uid_col_p) {
	let out = [];

	for(let key in tables) {
		let node;
		let table = tables[key];

		if(table.table) {
			// Regular tables
			let table_ref = [ table.schema, table.table ];

			if(table.alias) {
				let table_ref = [ table.alias ];
			}

			// Get the column reference node
			let ref = table_ref.concat([ uid_col ]);

			node = concatNode(columnRefNode(ref), constantNode('|'));
		}
		else {
			// Aliased subqueries
			let ref = [ table.alias, uid_col_p ];

			// Get a reference to the subquery column
			node = concatNode(columnRefNode(ref), constantNode('|'));
		}

		// Aggregate the column if necessary
		if(grouped) {
			node = functionNode('string_agg', [ node, constantNode('|') ]);
		}

		out.push(node);
	}

	// Concatenate all the nodes together
	out = concatNodes(out);

	return selectTargetNode(out, uid_col_p);
}

// Helper function to generate a composite uid node
function compositeRevNode(tables, grouped, rev_col, rev_col_p) {
	let out = [];

	for(let key in tables) {
		let node;
		let table = tables[key];

		if(table.table) {
			// Regular tables
			let table_ref = [ table.schema, table.table ];

			if(table.alias) {
				let table_ref = [ table.alias ];
			}

			// Get the column reference nodes
			let ref  = table_ref.concat([ rev_col ]);

			node = columnRefNode(ref);
		}
		else {
			// Aliased subqueries
			let ref = [ table.alias, rev_col_p ];

			// Get a reference to the subquery column
			node = columnRefNode(ref);
		}

		// Aggregate the column if necessary
		if(grouped) {
			node = functionNode('max', [ node ]);
		}

		out.push(node);
	}

	return selectTargetNode(minmaxNode(out, 'max'), rev_col_p);
}

// Helper function to get a select target node
function selectTargetNode(node, alias) {
	return {
		ResTarget : {
			name : alias,
			val  : node
		}
	};
}

// Helper function to generate a column reference node
function columnRefNode(ref) {
	return {
		ColumnRef : {
			fields : ref.map((field) => {
				return {
					String : {
						str : field
					}
				}
			})
		}
	}
}

// Helper function to generate a type cast node
function castNode(node, type) {
	return {
		TypeCast : {
			arg : node,

			typeName : {
				TypeName : {
					names : [
						{
							String : {
								str : type
							}
						}
					],

					typemod : -1
				}
			}
		}
	}
}

// Helper function to generate a function call node
function functionNode(func, args) {
	return {
		FuncCall : {
			funcname : [
				{
					String : {
						str : func.toLowerCase()
					}
				}
			],

			args : args
		}
	};
}

// Helper function to generate a constant node
function constantNode(value) {
	let types = [ 'String', 'str' ];

	if(typeof value === 'number') {
		if(Number.isInteger(value)) {
			types = [ 'Integer', 'ival' ];
		}
		else {
			types = [ 'Float', 'str' ];
			value = String(value);
		}
	}

	let outer = {};
	let inner = {};

	inner[types[1]] = value;
	outer[types[0]] = inner;

	return {
		A_Const : {
			val : outer
		}
	}
}

// Helper function to generate a 'least'/'greatest' node
function minmaxNode(nodes, mode) {
	if(nodes.length === 1) {
		return nodes[0];
	}

	return {
		MinMaxExpr : {
			op   : mode === 'min' ? 1 : 0,
			args : nodes
		}
	};
}

// Helper function to concatenate multiple nodes ('||')
function concatNodes(nodes) {
	if(nodes.length === 1) {
		return nodes[0];
	}

	return concatNode(nodes.shift(), concatNodes(nodes));
}

// Helper function to generate a concat node ('||')
function concatNode(lnode, rnode) {
	return {
		A_Expr : {
			kind : 0,

			name : [
				{
					String : {
						str : '||'
					}
				}
			],

			lexpr : lnode,
			rexpr : rnode
		}
	};
}

// Helper function to generate an array node
function arrayNode(nodes) {
	return {
		A_ArrayExpr : {
			elements : nodes
		}
	};
}

module.exports = PGUIDs;