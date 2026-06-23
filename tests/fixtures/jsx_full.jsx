
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import PropTypes from 'prop-types';

const DataGrid = ({ url, columns, pageSize }) => {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [page, setPage] = useState(0);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const response = await fetch(`${url}?page=${page}&size=${pageSize}`);
            if (!response.ok) throw new Error("Network error");
            const result = await response.json();
            setData(result.items);
            setError(null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [url, page, pageSize]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const renderedHeaders = useMemo(() => {
        return (
            <tr>
                {columns.map(col => <th key={col.key}>{col.title}</th>)}
            </tr>
        );
    }, [columns]);

    if (error) return <div className="error">{error}</div>;
    if (loading) return <div className="spinner" />;

    return (
        <div className="data-grid-container">
            <table>
                <thead>{renderedHeaders}</thead>
                <tbody>
                    {data.map(row => (
                        <tr key={row.id}>
                            {columns.map(col => <td key={col.key}>{row[col.key]}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="pagination">
                <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
                <span>Page {page + 1}</span>
                <button onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
        </div>
    );
};

DataGrid.propTypes = {
    url: PropTypes.string.isRequired,
    columns: PropTypes.array.isRequired,
    pageSize: PropTypes.number
};

DataGrid.defaultProps = {
    pageSize: 10
};

export default DataGrid;
