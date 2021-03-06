// Promise-ify a query
const query = (client, query, params) => {
	return  new Promise((resolve, reject) => {
		const args = [ query ];

		// Add the query parameters
		if(params && params.length) {
			args.push(params);
		}

		// Add a callback to resolve the promise
		args.push((error, result) => {
			error ? reject(error) : resolve(result);
		});

		client.query.apply(client, args);
	});

	return promise;
};

// Promise-ify multiple queries
const queries = (client, queries) => {
	return queries.reduce((p, c, i) => {
		c = (c instanceof Array) ? c : [ c ];

		return p.then((r) => {
			return query(client, c[0], c[1]).then((next) => r.concat(next));
		});
	}, Promise.resolve([]));
};

// Quote an Identifier/Literal
const quote = (str, literal) => {
	if(literal) {
		return str.replace(/'/g, "''");
	}

	return `"${str.replace(/"/g, '""')}"`;
};

// Generate a table reference string
const tableRef = (table, alias) => {
	const parts = [];

	if(alias && table.alias) {
		parts.push(table.alias);
	}
	else {
		if(table.schema) {
			parts.push(table.schema);
		}

		parts.push(table.table);
	}

	return parts.map(quote).join('.');
};

// Get a column reference node from a table/subquery
const getColumnRefNode = (table, col, alias_col) => {
	alias_col = alias_col || col;

	const ref = [];

	if(table.alias) {
		// Table aliases/subqueries
		ref.push(table.alias, alias_col);
	}
	else {
		// Normal table references
		if(table.schema) {
			ref.push(table.schema);
		}

		ref.push(table.table, col);
	}

	return columnRefNode(ref);
}

// Generate a composite uid node
const compositeUidNode = (tables, grouped, uid_col, uid_col_p) => {
	let out = [];

	for(const key in tables) {
		const table = tables[key];

		// Get a column reference node
		let node = getColumnRefNode(table, uid_col, uid_col_p);

		// Append a separator character
		node = functionNode('int8send', [ node ]);

		// Aggregate the column if necessary
		if(grouped) {
			node = functionNode('string_agg', [ node, constantNode('|') ]);
			node = functionNode('md5', [ node ]);
		}

		out.push(node);
	}

	// Concatenate all the nodes together
	out = functionNode('md5', [ exprNodes(out, '||') ]);

	return selectTargetNode(out, uid_col_p);
}

// Generate a composite uid node
const compositeRevNode = (tables, grouped, rev_col, rev_col_p) => {
	let out = [];

	for(const key in tables) {
		const table = tables[key];

		// Get a column reference node
		let node = getColumnRefNode(table, rev_col, rev_col_p);

		// Aggregate the column if necessary
		if(grouped) {
			node = functionNode('max', [ node ]);
		}

		out.push(node);
	}

	return selectTargetNode(minmaxNode(out, 'max'), rev_col_p);
}

// Get a select target node
const selectTargetNode = (node, alias) => {
	return {
		ResTarget : {
			name : alias,
			val  : node
		}
	};
}

// Generate a column reference node
const columnRefNode = (ref) => {
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

// Generate a type cast node
const castNode = (node, type) => {
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

// Generate a const call =  no =>de
const functionNode = (func, args) => {
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

// Generate a constant node
const constantNode = (value) => {
	const types = [ 'String', 'str' ];

	if(typeof value === 'number') {
		if(Number.isInteger(value)) {
			types = [ 'Integer', 'ival' ];
		}
		else {
			types = [ 'Float', 'str' ];
			value = String(value);
		}
	}

	const outer = {};
	const inner = {};

	inner[types[1]] = value;
	outer[types[0]] = inner;

	return {
		A_Const : {
			val : outer
		}
	}
}

// Generate a 'least'/'greatest' node
const minmaxNode = (nodes, mode) => {
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

// Generate multiple expression nodes
const exprNodes = (nodes, op) => {
	if(nodes.length === 1) {
		return nodes[0];
	}

	return exprNode(nodes.shift(), op, exprNodes(nodes, op));
}

// Generate an expression node
const exprNode = (lnode, op, rnode) => {
	return {
		A_Expr : {
			kind : 0,

			name : [
				{
					String : {
						str : op
					}
				}
			],

			lexpr : lnode,
			rexpr : rnode
		}
	};
}

// Generate an array node
const arrayNode = (nodes) => {
	return {
		A_ArrayExpr : {
			elements : nodes
		}
	};
}

// Node functions
const nodes = {
	compositeRevNode,
	compositeUidNode
};

module.exports = { query, queries, quote, tableRef, nodes };
